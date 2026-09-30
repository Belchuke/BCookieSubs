using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class ApplicationConfigConfiguration : IEntityTypeConfiguration<ApplicationConfig>
{
    public void Configure(EntityTypeBuilder<ApplicationConfig> builder)
    {
        builder.ToTable("application_config");

        builder.HasKey(c => c.Id);
        builder.Property(c => c.Id).ValueGeneratedNever();

        builder.Property(c => c.DefaultLanguage).HasMaxLength(35).IsRequired();
        builder.Property(c => c.ThaiAssFont).HasMaxLength(100).IsRequired();
        builder.Property(c => c.WhisperModel).HasMaxLength(100).IsRequired();
        builder.Property(c => c.RootLibraryPath).HasMaxLength(500);

        builder.Property(c => c.Version).IsRowVersion();

        builder.HasOne(c => c.SelectedTheme)
            .WithMany()
            .HasForeignKey(c => c.SelectedThemeId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}

public class ApplicationSecretConfiguration : IEntityTypeConfiguration<ApplicationSecret>
{
    public void Configure(EntityTypeBuilder<ApplicationSecret> builder)
    {
        builder.ToTable("app_secrets");

        builder.Property(s => s.Key).HasMaxLength(100).IsRequired();
        builder.HasIndex(s => s.Key).IsUnique();
        builder.Property(s => s.Algorithm).HasMaxLength(32).IsRequired();

        builder.Property(s => s.Ciphertext).IsRequired();
        builder.Property(s => s.Nonce).IsRequired();
        builder.Property(s => s.Tag).IsRequired();
    }
}

public class ScheduleConfiguration : IEntityTypeConfiguration<Schedule>
{
    public void Configure(EntityTypeBuilder<Schedule> builder)
    {
        builder.ToTable("schedules");

        builder.Property(s => s.TaskName).HasMaxLength(100).IsRequired();
        builder.Property(s => s.DayOfTheWeek).HasConversion<string>().HasMaxLength(16);
        builder.Property(s => s.StartTime).HasColumnType("time");
        builder.Property(s => s.RepeatUnit).HasConversion<string>().HasMaxLength(16);

        builder.ToTable(t => t.HasCheckConstraint("CK_schedules_duration_positive", "\"DurationMinutes\" > 0"));
        builder.ToTable(t => t.HasCheckConstraint("CK_schedules_interval_positive", "\"RepeatInterval\" > 0"));
    }
}

public class PermissionConfiguration : IEntityTypeConfiguration<Permission>
{
    public void Configure(EntityTypeBuilder<Permission> builder)
    {
        builder.ToTable("permissions");

        builder.Property(p => p.Key).HasMaxLength(100).IsRequired();
        builder.HasIndex(p => p.Key).IsUnique();
        builder.Property(p => p.Label).HasMaxLength(100).IsRequired();
        builder.Property(p => p.Description).HasMaxLength(500).IsRequired();
        builder.Property(p => p.Category).HasMaxLength(50);
    }
}