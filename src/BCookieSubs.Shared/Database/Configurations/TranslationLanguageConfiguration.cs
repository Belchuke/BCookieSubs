using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class ConfigTranslationLanguageConfiguration : IEntityTypeConfiguration<ConfigTranslationLanguage>
{
    public void Configure(EntityTypeBuilder<ConfigTranslationLanguage> builder)
    {
        builder.ToTable("config_translation_languages");

        builder.HasOne(c => c.Language)
            .WithMany()
            .HasForeignKey(c => c.LanguageId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(c => c.LanguageId).IsUnique();
    }
}

public class UserConfigTranslationLanguageConfiguration : IEntityTypeConfiguration<UserConfigTranslationLanguage>
{
    public void Configure(EntityTypeBuilder<UserConfigTranslationLanguage> builder)
    {
        builder.ToTable("user_config_translation_languages");

        builder.HasOne(c => c.User)
            .WithMany()
            .HasForeignKey(c => c.UserId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasOne(c => c.Language)
            .WithMany()
            .HasForeignKey(c => c.LanguageId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.HasIndex(c => new { c.UserId, c.LanguageId }).IsUnique();
    }
}