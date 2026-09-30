using BCookieSubs.Shared.Database;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;

namespace BCookieSubs.Shared.Repositories;

public class ApplicationConfigRepository(BCookieSubsDbContext db)
{
    public Task<ApplicationConfig?> GetAsync(CancellationToken ct = default) =>
        db.ApplicationConfig.FirstOrDefaultAsync(c => c.Id == ApplicationConfig.SingletonId, ct);

    public Task SaveAsync(CancellationToken ct = default) => db.SaveChangesAsync(ct);

    public bool HasChanges() => db.ChangeTracker.HasChanges();

    public string? GetDatabaseProvider() => db.Database.ProviderName;
}