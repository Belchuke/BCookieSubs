using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class WorkerCredentialConfiguration : IEntityTypeConfiguration<WorkerCredential>
{
    public void Configure(EntityTypeBuilder<WorkerCredential> builder)
    {
        builder.ToTable("worker_credentials");

        builder.Property(c => c.SecretHash).HasMaxLength(64).IsRequired();
        builder.HasIndex(c => c.WorkerId);
        builder.HasIndex(c => c.SecretHash);

        builder.HasOne(c => c.Worker)
            .WithMany()
            .HasForeignKey(c => c.WorkerId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}