using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class ApplicationUserConfiguration : IEntityTypeConfiguration<ApplicationUser>
{
    public void Configure(EntityTypeBuilder<ApplicationUser> builder)
    {
        builder.Property(u => u.Language).HasMaxLength(35);

        builder.HasOne(u => u.SelectedTheme)
            .WithMany()
            .HasForeignKey(u => u.SelectedThemeId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}

public class ApplicationRoleConfiguration : IEntityTypeConfiguration<ApplicationRole>
{
    public void Configure(EntityTypeBuilder<ApplicationRole> builder)
    {
        builder.Property(r => r.Description).HasMaxLength(500);

        builder.HasIndex(r => r.Level).IsUnique();
    }
}