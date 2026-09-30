using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Grpc;
using BCookieSubs.Shared.Services;
using BCookieSubs.Worker.Services;
using Grpc.Core;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Worker.Workers;

public class WorkerGatewayService(
    WorkerAuthenticationService authentication,
    WorkerGatewayOrchestrator orchestrator,
    OrchestrationEventBus events,
    IServiceScopeFactory scopeFactory,
    ILogger<WorkerGatewayService> logger) : WorkerGateway.WorkerGatewayBase
{
    public override async Task Connect(
        IAsyncStreamReader<ClientMessage> requestStream,
        IServerStreamWriter<ServerMessage> responseStream,
        ServerCallContext context)
    {
        if (!await requestStream.MoveNext(context.CancellationToken))
        {
            return;
        }

        var first = requestStream.Current;
        WorkerNode? node = null;

        switch (first.PayloadCase)
        {
            case ClientMessage.PayloadOneofCase.Enroll:
                node = await EnrollOrRejectAsync(first.Enroll, responseStream, context);
                break;

            case ClientMessage.PayloadOneofCase.Auth:
                node = await AuthenticateOrRejectAsync(first.Auth, responseStream, context);
                break;
        }

        if (node is null)
        {
            return;
        }

        var isAuth = first.PayloadCase == ClientMessage.PayloadOneofCase.Auth;
        var session = new WorkerSession
        {
            ConnectionId = Guid.NewGuid().ToString("N"),
            WorkerId = node.Id,
            ResponseStream = responseStream,
            Lifetime = CancellationTokenSource.CreateLinkedTokenSource(context.CancellationToken),
            WorkerVersion = isAuth ? first.Auth.WorkerVersion : first.Enroll.WorkerVersion,
            MachineIdentifier = isAuth ? first.Auth.MachineIdentifier : first.Enroll.MachineIdentifier
        };

        await orchestrator.OnSessionRegisteredAsync(session, node, first);

        try
        {
            await foreach (var message in requestStream.ReadAllAsync(session.Lifetime.Token))
            {
                switch (message.PayloadCase)
                {
                    case ClientMessage.PayloadOneofCase.Heartbeat:
                        session.LastHeartbeatAt = DateTime.UtcNow;
                        session.Ready = message.Heartbeat.Ready;
                        session.ActiveJobs = message.Heartbeat.ActiveJobs;
                        break;

                    case ClientMessage.PayloadOneofCase.JobProgress:
                        await HandleJobProgressAsync(session.WorkerId, message.JobProgress);
                        break;

                    case ClientMessage.PayloadOneofCase.JobResult:
                        session.ActiveJobs = Math.Max(0, session.ActiveJobs - 1);
                        await HandleJobResultAsync(session.WorkerId, message.JobResult);
                        break;

                    case ClientMessage.PayloadOneofCase.Disconnect:
                        logger.LogInformation("Worker {WorkerId} disconnecting: {Reason}", node.Id, message.Disconnect.Reason);
                        return;
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (IOException ex)
        {
            logger.LogDebug(ex, "Worker {WorkerId} stream failed", node.Id);
        }
        finally
        {
            session.Lifetime.Cancel();
            await orchestrator.OnSessionClosedAsync(session);
            session.Lifetime.Dispose();
        }
    }

    private async Task HandleJobProgressAsync(long workerId, JobProgress progress)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var compute = scope.ServiceProvider.GetRequiredService<ComputeJobService>();
            await compute.HandleProgressAsync(progress.JobId, workerId, progress.Progress, progress.Status);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Job progress handling failed for job {JobId}", progress.JobId);
        }
    }

    private async Task HandleJobResultAsync(long workerId, JobResult result)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var compute = scope.ServiceProvider.GetRequiredService<ComputeJobService>();
            await compute.HandleResultAsync(
                result.JobId, workerId, result.Success, result.Result, result.ErrorCode, result.ErrorMessage);
        }
        catch (Exception e)
        {
            logger.LogWarning(e, "Job result handling failed for job {JobId}", result.JobId);
        }
    }

    private async Task<WorkerNode?> EnrollOrRejectAsync(EnrollRequest request, IServerStreamWriter<ServerMessage> responseStream, ServerCallContext context)
    {
        try
        {
            var (node, secret, token) = await authentication.EnrollAsync(
                request.EnrollmentToken,
                request.WorkerName,
                request.MachineIdentifier,
                request.WorkerVersion,
                request.Capabilities,
                request.MaxConcurrency,
                request.Hardware.ToHardware(),
                context.CancellationToken);

            await responseStream.WriteAsync(new ServerMessage
            {
                EnrollResult = new EnrollResult
                {
                    Success = true,
                    WorkerId = node.Id,
                    WorkerSecret = secret,
                    AssignedName = node.Name,
                    Token = token
                }
            });

            events.Publish(OrchestrationEventType.Enrolled, node.Id, $"enrolled as {node.Name}");
            return node;
        }
        catch (WorkerAuthenticationException ex)
        {
            logger.LogWarning("Worker enrollment rejected (machine={Machine}): {Message}",
                request.MachineIdentifier, ex.Message);
            await responseStream.WriteAsync(new ServerMessage
            {
                EnrollResult = new EnrollResult { Success = false, Message = ex.Message }
            });
            return null;
        }
    }

    private async Task<WorkerNode?> AuthenticateOrRejectAsync(AuthRequest request, IServerStreamWriter<ServerMessage> responseStream, ServerCallContext context)
    {
        try
        {
            var node = await authentication.AuthenticateAsync(request.WorkerId, request.WorkerSecret, context.CancellationToken);
            await responseStream.WriteAsync(new ServerMessage
            {
                AuthResult = new AuthResult { Success = true, Token = authentication.CreateToken(node) }
            });
            return node;
        }
        catch (WorkerAuthenticationException ex)
        {
            logger.LogWarning("Worker auth rejected (workerId={WorkerId}, machine={Machine}): {Message}",
                request.WorkerId, request.MachineIdentifier, ex.Message);
            await responseStream.WriteAsync(new ServerMessage
            {
                AuthResult = new AuthResult { Success = false, Message = ex.Message }
            });
            return null;
        }
    }
}