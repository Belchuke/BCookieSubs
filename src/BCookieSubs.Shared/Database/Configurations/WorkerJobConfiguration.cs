using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class WorkerJobConfiguration : IEntityTypeConfiguration<WorkerJob>
{
    public void Configure(EntityTypeBuilder<WorkerJob> builder)
    {
        builder.ToTable("worker_jobs");

        builder.Property(j => j.JobType).HasMaxLength(50).IsRequired();
        builder.Property(j => j.Status).HasConversion<string>().HasMaxLength(16);
        builder.Property(j => j.RequiredCapability).HasMaxLength(50);
        builder.Property(j => j.SubjectType).HasMaxLength(50);
        builder.Property(j => j.DisplayName).HasMaxLength(300);
        builder.Property(j => j.ErrorCode).HasMaxLength(100);
        builder.Property(j => j.ErrorMessage).HasMaxLength(1000);

        builder.Property(j => j.Payload).HasColumnType("jsonb");
        builder.Property(j => j.Result).HasColumnType("jsonb");

        builder.HasOne(j => j.ClaimedByWorker)
            .WithMany()
            .HasForeignKey(j => j.ClaimedByWorkerId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(j => j.CreatedByUser)
            .WithMany()
            .HasForeignKey(j => j.CreatedByUserId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasIndex(j => new { j.Status, j.Priority, j.CreatedAt });
        builder.HasIndex(j => new { j.ClaimedByWorkerId, j.Status });
        builder.HasIndex(j => new { j.SubjectType, j.SubjectId });

        builder.HasIndex(j => new { j.JobType, j.SubjectType, j.SubjectId })
            .IsUnique()
            .HasFilter("\"Status\" IN ('Queued', 'Running')");
    }
}

public class ExportedSubtitleFileConfiguration : IEntityTypeConfiguration<ExportedSubtitleFile>
{
    public void Configure(EntityTypeBuilder<ExportedSubtitleFile> builder)
    {
        builder.ToTable("exported_subtitle_files");

        builder.HasOne(f => f.LibraryPath)
            .WithMany()
            .HasForeignKey(f => f.LibraryPathId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(f => f.Subtitle)
            .WithMany()
            .HasForeignKey(f => f.SubtitleId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.Property(f => f.Path).HasMaxLength(500).IsRequired();

        builder.HasIndex(f => new { f.LibraryPathId, f.Path }).IsUnique();
    }
}

public class TranslatedLibraryItemConfiguration : IEntityTypeConfiguration<TranslatedLibraryItem>
{
    public void Configure(EntityTypeBuilder<TranslatedLibraryItem> builder)
    {
        builder.ToTable("translated_library_items");

        builder.HasOne(t => t.LibraryPathItem)
            .WithMany()
            .HasForeignKey(t => t.LibraryPathItemId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(t => t.Language)
            .WithMany()
            .HasForeignKey(t => t.LanguageId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.Property(t => t.DetectedAtPath).HasMaxLength(500).IsRequired();

        builder.HasIndex(t => new { t.LibraryPathItemId, t.LanguageId }).IsUnique();
    }
}

public class ApplicationLogConfiguration : IEntityTypeConfiguration<ApplicationLog>
{
    public void Configure(EntityTypeBuilder<ApplicationLog> builder)
    {
        builder.ToTable("application_logs");

        builder.Property(l => l.Level).HasConversion<string>().HasMaxLength(16);
        builder.Property(l => l.Type).HasMaxLength(100);
        builder.Property(l => l.EntityType).HasMaxLength(100);
        builder.Property(l => l.Message).IsRequired();
        builder.Property(l => l.Metadata).HasColumnType("jsonb");

        builder.HasIndex(l => l.CreatedAt);
        builder.HasIndex(l => new { l.EntityType, l.EntityId });
        builder.HasIndex(l => l.Type);
    }
}