using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class LibraryPathConfiguration : IEntityTypeConfiguration<LibraryPath>
{
    public void Configure(EntityTypeBuilder<LibraryPath> builder)
    {
        builder.ToTable("library_paths");

        builder.Property(p => p.Name).HasMaxLength(200).IsRequired();
        builder.HasIndex(p => p.Name).IsUnique();
        builder.Property(p => p.Path).HasMaxLength(500).IsRequired();

        builder.HasIndex(p => p.Path).IsUnique().HasFilter("\"Storage\" = 'Local'");
        builder.HasIndex(p => new { p.SftpHost, p.Path }).IsUnique().HasFilter("\"Storage\" = 'Sftp'");

        builder.Property(p => p.Storage).HasConversion<string>().HasMaxLength(16);
        builder.Property(p => p.SftpHost).HasMaxLength(255);
        builder.Property(p => p.SftpUsername).HasMaxLength(100);
        builder.Property(p => p.SftpAuthMode).HasConversion<string>().HasMaxLength(16);
        builder.Property(p => p.SftpHostKeyFingerprint).HasMaxLength(100);

        builder.HasOne(p => p.SourceLanguage)
            .WithMany()
            .HasForeignKey(p => p.SourceLanguageId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.Property(p => p.State).HasConversion<string>().HasMaxLength(16);
        builder.Property(p => p.Type).HasConversion<string>().HasMaxLength(16);
        builder.Property(p => p.ScanMode).HasConversion<string>().HasMaxLength(16);
        builder.Property(p => p.ScanRepeatUnit).HasConversion<string>().HasMaxLength(16);
        builder.Property(p => p.ScanDayOfWeek).HasConversion<string>().HasMaxLength(16);
        builder.Property(p => p.ScanStartTime).HasColumnType("time");
    }
}

public class LibraryPathItemConfiguration : IEntityTypeConfiguration<LibraryPathItem>
{
    public void Configure(EntityTypeBuilder<LibraryPathItem> builder)
    {
        builder.ToTable("library_path_items");

        builder.HasOne(i => i.LibraryPath)
            .WithMany()
            .HasForeignKey(i => i.LibraryPathId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(i => i.MediaItem)
            .WithMany()
            .HasForeignKey(i => i.MediaItemId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.Property(i => i.Status).HasConversion<string>().HasMaxLength(24);
        builder.Property(i => i.Path).HasMaxLength(500).IsRequired();
        builder.Property(i => i.ExtractFileName).HasMaxLength(300).IsRequired();

        builder.HasIndex(i => new { i.LibraryPathId, i.Path }).IsUnique();
        builder.HasIndex(i => new { i.LibraryPathId, i.Status });
        builder.HasIndex(i => i.ExtractFileName);
    }
}

public class LibraryPathItemBlacklistConfiguration : IEntityTypeConfiguration<LibraryPathItemBlacklist>
{
    public void Configure(EntityTypeBuilder<LibraryPathItemBlacklist> builder)
    {
        builder.ToTable("library_path_item_blacklist");

        builder.HasOne(b => b.LibraryPathItem)
            .WithMany()
            .HasForeignKey(b => b.LibraryPathItemId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(b => b.BlacklistedByUser)
            .WithMany()
            .HasForeignKey(b => b.BlacklistedByUserId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.Property(b => b.Reason).HasMaxLength(500);

        builder.HasIndex(b => b.LibraryPathItemId).IsUnique();
    }
}

public class LibraryPathItemCandidateConfiguration : IEntityTypeConfiguration<LibraryPathItemCandidate>
{
    public void Configure(EntityTypeBuilder<LibraryPathItemCandidate> builder)
    {
        builder.ToTable("library_path_item_candidates");

        builder.HasOne(c => c.LibraryPathItem)
            .WithMany()
            .HasForeignKey(c => c.LibraryPathItemId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(c => c.MediaItem)
            .WithMany()
            .HasForeignKey(c => c.MediaItemId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.Property(c => c.Path).HasMaxLength(500).IsRequired();

        builder.HasIndex(c => new { c.LibraryPathItemId, c.MediaItemId }).IsUnique();
    }
}

public class LibraryPathItemSubtitleSourceConfiguration : IEntityTypeConfiguration<LibraryPathItemSubtitleSource>
{
    public void Configure(EntityTypeBuilder<LibraryPathItemSubtitleSource> builder)
    {
        builder.ToTable("library_path_item_subtitle_sources");

        builder.HasKey(s => s.LibraryPathItemId);

        builder.HasOne(s => s.LibraryPathItem)
            .WithOne()
            .HasForeignKey<LibraryPathItemSubtitleSource>(s => s.LibraryPathItemId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.Property(s => s.Sources).HasJsonbConversion();
    }
}