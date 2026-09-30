using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class LanguageConfiguration : IEntityTypeConfiguration<Language>
{
    public void Configure(EntityTypeBuilder<Language> builder)
    {
        builder.ToTable("languages");

        builder.Property(l => l.Name).HasMaxLength(100).IsRequired();
        builder.Property(l => l.Iso639).HasMaxLength(8).IsRequired();
        builder.Property(l => l.Iso6392B).HasMaxLength(8);
        builder.Property(l => l.Locale).HasMaxLength(35).IsRequired();
        builder.Property(l => l.Flag).HasMaxLength(16);

        builder.HasIndex(l => new { l.Iso639, l.Locale }).IsUnique();
    }
}