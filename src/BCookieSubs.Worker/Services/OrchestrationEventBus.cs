using System.Collections.Concurrent;
using System.Threading.Channels;
using BCookieSubs.Shared.Grpc;

namespace BCookieSubs.Worker.Services;

public class OrchestrationEventBus
{
    private readonly ConcurrentDictionary<long, Channel<OrchestrationEvent>> _subscribers = new();
    private long _nextSubscriberId;

    public IDisposable Subscribe(out ChannelReader<OrchestrationEvent> reader)
    {
        var id = Interlocked.Increment(ref _nextSubscriberId);
        var channel = Channel.CreateUnbounded<OrchestrationEvent>(new UnboundedChannelOptions { SingleReader = true });
        _subscribers[id] = channel;
        reader = channel.Reader;
        return new Subscription(this, id, channel);
    }

    public void Publish(OrchestrationEventType type, long workerId, string detail)
    {
        var evt = new OrchestrationEvent
        {
            Type = type,
            WorkerId = workerId,
            OccurredAtUnix = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            Detail = detail
        };
        foreach (var subscriber in _subscribers.Values)
        {
            subscriber.Writer.TryWrite(evt);
        }
    }

    private sealed class Subscription(OrchestrationEventBus bus, long id, Channel<OrchestrationEvent> channel) : IDisposable
    {
        public void Dispose()
        {
            bus._subscribers.TryRemove(id, out _);
            channel.Writer.TryComplete();
        }
    }
}