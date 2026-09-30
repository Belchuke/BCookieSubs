using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class ThemeConfiguration : IEntityTypeConfiguration<Theme>
{
    public void Configure(EntityTypeBuilder<Theme> builder)
    {
        builder.ToTable("themes");

        builder.Property(t => t.Name).HasMaxLength(100).IsRequired();
        builder.HasIndex(t => t.Name).IsUnique();

        builder.Property(t => t.Bg).HasMaxLength(32).IsRequired();
        builder.Property(t => t.Surface).HasMaxLength(32).IsRequired();
        builder.Property(t => t.Surface2).HasMaxLength(32).IsRequired();
        builder.Property(t => t.Surface3).HasMaxLength(32).IsRequired();
        builder.Property(t => t.BorderColor).HasMaxLength(32).IsRequired();
        builder.Property(t => t.TextColor).HasMaxLength(32).IsRequired();
        builder.Property(t => t.TextDim).HasMaxLength(32).IsRequired();
        builder.Property(t => t.TextHint).HasMaxLength(32).IsRequired();
        builder.Property(t => t.Accent).HasMaxLength(32).IsRequired();
        builder.Property(t => t.AccentDim).HasMaxLength(32).IsRequired();
        builder.Property(t => t.Success).HasMaxLength(32).IsRequired();
        builder.Property(t => t.SuccessDim).HasMaxLength(32).IsRequired();
        builder.Property(t => t.Warning).HasMaxLength(32).IsRequired();
        builder.Property(t => t.WarningDim).HasMaxLength(32).IsRequired();
        builder.Property(t => t.Error).HasMaxLength(32).IsRequired();
        builder.Property(t => t.ErrorDim).HasMaxLength(32).IsRequired();
        builder.Property(t => t.InfoDim).HasMaxLength(32).IsRequired();

        builder.HasOne(t => t.CreatedByUser)
            .WithMany()
            .HasForeignKey(t => t.CreatedByUserId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}