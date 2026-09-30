using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace BCookieSubs.Shared.Database;

public static class DatabaseInitializer
{
    private const long MigrationLockKey = 730423715744001;

    public static async Task ApplyMigrationsAsync(
        BCookieSubsDbContext db, ILogger? logger = null, CancellationToken ct = default)
    {
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            await ExecuteOnConnectionAsync(db, $"SELECT pg_advisory_lock({MigrationLockKey});", ct);
            try
            {
                await db.Database.MigrateAsync(ct);
                await DatabaseSeeder.SeedAsync(db, logger, ct);
            }
            finally
            {
                await ExecuteOnConnectionAsync(db, $"SELECT pg_advisory_unlock({MigrationLockKey});", ct);
            }
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    private static async Task ExecuteOnConnectionAsync(BCookieSubsDbContext db, string sql, CancellationToken ct)
    {
        var connection = db.Database.GetDbConnection();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(ct);
    }
}