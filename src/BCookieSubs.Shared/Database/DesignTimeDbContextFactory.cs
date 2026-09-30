using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace BCookieSubs.Shared.Database;

public class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<BCookieSubsDbContext>
{
    public BCookieSubsDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ConnectionStrings__Default")
            ?? "Host=localhost;Port=5432;Database=bcsub_design;Username=postgres;Password=postgres";

        var options = new DbContextOptionsBuilder<BCookieSubsDbContext>()
            .UseNpgsql(connectionString, sql => sql.MigrationsAssembly(typeof(BCookieSubsDbContext).Assembly.FullName))
            .Options;

        return new BCookieSubsDbContext(options);
    }
}