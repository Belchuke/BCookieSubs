using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class SubtitleConfiguration : IEntityTypeConfiguration<Subtitle>
{
    public void Configure(EntityTypeBuilder<Subtitle> builder)
    {
        builder.ToTable("subtitles");

        builder.HasOne(s => s.User)
            .WithMany()
            .HasForeignKey(s => s.UserId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(s => s.SourceLanguage)
            .WithMany()
            .HasForeignKey(s => s.SourceLanguageId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(s => s.MediaItem)
            .WithMany()
            .HasForeignKey(s => s.MediaItemId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(s => s.LibraryPathItem)
            .WithMany()
            .HasForeignKey(s => s.LibraryPathItemId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(s => s.CancelledByUser)
            .WithMany()
            .HasForeignKey(s => s.CancelledByUserId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(s => s.DeletedByUser)
            .WithMany()
            .HasForeignKey(s => s.DeletedByUserId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.Property(s => s.Name).HasMaxLength(300).IsRequired();
        builder.Property(s => s.OriginalFileHash).HasMaxLength(64).IsRequired();
        builder.Property(s => s.OriginalFileName).HasMaxLength(300).IsRequired();
        builder.Property(s => s.SourcePath).HasMaxLength(500);
        builder.Property(s => s.MediaPath).HasMaxLength(500);
        builder.Property(s => s.WhisperModel).HasMaxLength(100);
        builder.Property(s => s.SourceFormat).HasConversion<string>().HasMaxLength(8);
        builder.Property(s => s.TextOrigin).HasConversion<string>().HasMaxLength(16);
        builder.Property(s => s.OriginalSourceFormat).HasConversion<string>().HasMaxLength(8);
        builder.Property(s => s.Source).HasConversion<string>().HasMaxLength(16);
        builder.Property(s => s.Status).HasConversion<string>().HasMaxLength(16);
        builder.Property(s => s.WhisperTranscriptionState).HasConversion<string>().HasMaxLength(32);

        builder.HasIndex(s => s.OriginalFileHash);
        builder.HasIndex(s => new { s.Status, s.Priority });
        builder.HasIndex(s => s.WhisperTranscriptionState);
    }
}

public class SubtitleJobConfiguration : IEntityTypeConfiguration<SubtitleJob>
{
    public void Configure(EntityTypeBuilder<SubtitleJob> builder)
    {
        builder.ToTable("subtitle_jobs");

        builder.Property(j => j.Status).HasConversion<string>().HasMaxLength(16);

        builder.HasOne(j => j.Subtitle)
            .WithMany()
            .HasForeignKey(j => j.SubtitleId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(j => j.User)
            .WithMany()
            .HasForeignKey(j => j.UserId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(j => j.TargetLanguage)
            .WithMany()
            .HasForeignKey(j => j.TargetLanguageId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(j => j.CancelledByUser)
            .WithMany()
            .HasForeignKey(j => j.CancelledByUserId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(j => j.DeletedByUser)
            .WithMany()
            .HasForeignKey(j => j.DeletedByUserId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasIndex(j => new { j.SubtitleId, j.TargetLanguageId }).IsUnique();
        builder.HasIndex(j => new { j.Status, j.Priority });
    }
}

public class SubtitleChunkConfiguration : IEntityTypeConfiguration<SubtitleChunk>
{
    public void Configure(EntityTypeBuilder<SubtitleChunk> builder)
    {
        builder.ToTable("subtitle_chunks");

        builder.HasOne(c => c.Subtitle)
            .WithMany()
            .HasForeignKey(c => c.SubtitleId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(c => c.SubtitleJob)
            .WithMany()
            .HasForeignKey(c => c.SubtitleJobId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(c => c.TargetLanguage)
            .WithMany()
            .HasForeignKey(c => c.TargetLanguageId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(c => c.JudgeModel)
            .WithMany()
            .HasForeignKey(c => c.JudgeModelId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(c => c.SelectedCandidate)
            .WithMany()
            .HasForeignKey(c => c.SelectedCandidateId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.Property(c => c.Status).HasConversion<string>().HasMaxLength(24);

        builder.HasIndex(c => new { c.SubtitleJobId, c.ChunkIndex }).IsUnique();
        builder.HasIndex(c => c.SubtitleId);
        builder.HasIndex(c => new { c.Status, c.StartedAt });
    }
}

public class SubtitleChunkCandidateConfiguration : IEntityTypeConfiguration<SubtitleChunkCandidate>
{
    public void Configure(EntityTypeBuilder<SubtitleChunkCandidate> builder)
    {
        builder.ToTable("subtitle_chunk_candidates");

        builder.HasOne(c => c.SubtitleChunk)
            .WithMany()
            .HasForeignKey(c => c.SubtitleChunkId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(c => c.Model)
            .WithMany()
            .HasForeignKey(c => c.ModelId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(c => c.Prompt)
            .WithMany()
            .HasForeignKey(c => c.PromptId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(c => c.PromptVersion)
            .WithMany()
            .HasForeignKey(c => c.PromptVersionId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.Property(c => c.Status).HasConversion<string>().HasMaxLength(24);

        builder.HasIndex(c => new { c.SubtitleChunkId, c.ModelId, c.PromptVersionId })
            .IsUnique()
            .AreNullsDistinct(false);

        builder.HasIndex(c => c.ModelId);
        builder.HasIndex(c => new { c.Status, c.UpdatedAt });
    }
}