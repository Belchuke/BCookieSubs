using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class ModelConfiguration : IEntityTypeConfiguration<Model>
{
    public void Configure(EntityTypeBuilder<Model> builder)
    {
        builder.ToTable("models");

        builder.Property(m => m.Name).HasMaxLength(200).IsRequired();
        builder.Property(m => m.ModelName).HasMaxLength(200).IsRequired();
        builder.Property(m => m.Size).HasMaxLength(100);
        builder.Property(m => m.ParameterSize).HasMaxLength(100);
        builder.Property(m => m.ModelUpdatedAt).HasMaxLength(100);
        builder.Property(m => m.BaseUrl).HasMaxLength(500);
        builder.Property(m => m.Provider).HasConversion<string>().HasMaxLength(32);

        builder.HasIndex(m => new { m.ModelName, m.ModelUpdatedAt })
            .IsUnique()
            .AreNullsDistinct(false);

        builder.HasOne(m => m.RecommendedModel)
            .WithMany()
            .HasForeignKey(m => m.RecommendedModelId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

public class RecommendedModelConfiguration : IEntityTypeConfiguration<RecommendedModel>
{
    public void Configure(EntityTypeBuilder<RecommendedModel> builder)
    {
        builder.ToTable("recommended_models");

        builder.Property(r => r.Name).HasMaxLength(200).IsRequired();
        builder.HasIndex(r => r.Name).IsUnique();
        builder.Property(r => r.Size).HasMaxLength(100);
        builder.Property(r => r.ParameterSize).HasMaxLength(100);
        builder.Property(r => r.BaseUrl).HasMaxLength(500);
        builder.Property(r => r.Provider).HasConversion<string>().HasMaxLength(32);
        builder.Property(r => r.Score).HasMaxLength(300);

        builder.Property(r => r.Roles).HasJsonbConversion();
    }
}

public class ModelRoleConfiguration : IEntityTypeConfiguration<ModelRole>
{
    public void Configure(EntityTypeBuilder<ModelRole> builder)
    {
        builder.ToTable("model_roles");

        builder.HasOne(r => r.Model)
            .WithMany(m => m.ModelRoles)
            .HasForeignKey(r => r.ModelId)
            .OnDelete(DeleteBehavior.Cascade);

        builder.Property(r => r.Role).HasConversion<string>().HasMaxLength(32);

        builder.HasIndex(r => new { r.ModelId, r.Role }).IsUnique();
    }
}