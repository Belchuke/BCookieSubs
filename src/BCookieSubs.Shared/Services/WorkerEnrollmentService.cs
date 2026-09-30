using System.Globalization;
using BCookieSubs.Shared.Database.Entities;
using BCookieSubs.Shared.Repositories;
using BCookieSubs.Shared.Security;

namespace BCookieSubs.Shared.Services;

public class WorkerEnrollmentService(WorkerEnrollmentRepository enrollments)
{
    public async Task<(WorkerEnrollment Enrollment, string Token)> CreateAsync(long createdByUserId, string? label, CancellationToken ct = default)
    {
        var token = TokenGenerator.NewEnrollmentToken();
        var enrollment = new WorkerEnrollment
        {
            CodeHash = TokenGenerator.Sha256Hex(token),
            CodePrefix = TokenGenerator.PrefixForDisplay(token),
            Label = string.IsNullOrWhiteSpace(label) ? null : label.Trim()[..Math.Min(100, label.Trim().Length)],
            CreatedByUserId = createdByUserId,
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = DateTime.UtcNow.AddHours(24)
        };

        await enrollments.AddAsync(enrollment, ct);
        return (enrollment, token);
    }

    public Task<List<WorkerEnrollment>> GetRecentAsync(CancellationToken ct = default) =>
        enrollments.GetRecentAsync(ct);

    public Task<int> RevokeAsync(long id, CancellationToken ct = default) =>
        enrollments.RevokeAsync(id, ct);

    public static string FormatExpiration(WorkerEnrollment enrollment) =>
        enrollment.ExpiresAt.ToString("yyyy-MM-dd HH:mm 'UTC'", CultureInfo.InvariantCulture);
}