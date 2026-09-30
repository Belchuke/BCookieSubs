using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class PromptConfiguration : IEntityTypeConfiguration<Prompt>
{
    public void Configure(EntityTypeBuilder<Prompt> builder)
    {
        builder.ToTable("prompts");

        builder.Property(p => p.Name).HasMaxLength(200).IsRequired();
        builder.HasIndex(p => p.Name).IsUnique();
        builder.Property(p => p.Kind).HasConversion<string>().HasMaxLength(32);
    }
}

public class PromptVersionConfiguration : IEntityTypeConfiguration<PromptVersion>
{
    public void Configure(EntityTypeBuilder<PromptVersion> builder)
    {
        builder.ToTable("prompt_versions");

        builder.HasOne(v => v.Prompt)
            .WithMany()
            .HasForeignKey(v => v.PromptId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(v => new { v.PromptId, v.Version }).IsUnique();
    }
}

public class PromptStatConfiguration : IEntityTypeConfiguration<PromptStat>
{
    public void Configure(EntityTypeBuilder<PromptStat> builder)
    {
        builder.ToTable("prompt_stats");

        builder.HasOne(s => s.Prompt)
            .WithMany()
            .HasForeignKey(s => s.PromptId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(s => s.PromptVersion)
            .WithMany()
            .HasForeignKey(s => s.PromptVersionId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(s => s.Model)
            .WithMany()
            .HasForeignKey(s => s.ModelId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(s => s.Language)
            .WithMany()
            .HasForeignKey(s => s.LanguageId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasIndex(s => new { s.PromptId, s.PromptVersionId, s.ModelId, s.LanguageId })
            .IsUnique()
            .AreNullsDistinct(false);
        builder.HasIndex(s => s.ModelId);
    }
}

public class JudgeEvaluationConfiguration : IEntityTypeConfiguration<JudgeEvaluation>
{
    public void Configure(EntityTypeBuilder<JudgeEvaluation> builder)
    {
        builder.ToTable("judge_evaluations");

        builder.HasOne(e => e.SubtitleChunk)
            .WithMany()
            .HasForeignKey(e => e.SubtitleChunkId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(e => e.Model)
            .WithMany()
            .HasForeignKey(e => e.ModelId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasOne(e => e.SelectedCandidate)
            .WithMany()
            .HasForeignKey(e => e.SelectedCandidateId)
            .OnDelete(DeleteBehavior.SetNull);

        builder.HasIndex(e => e.CreatedAt);
        builder.HasIndex(e => new { e.ModelId, e.CreatedAt });
    }
}