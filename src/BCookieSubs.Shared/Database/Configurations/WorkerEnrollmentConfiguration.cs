using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class WorkerEnrollmentConfiguration : IEntityTypeConfiguration<WorkerEnrollment>
{
    public void Configure(EntityTypeBuilder<WorkerEnrollment> builder)
    {
        builder.ToTable("worker_enrollments");

        builder.Property(e => e.CodeHash).HasMaxLength(64).IsRequired();
        builder.Property(e => e.CodePrefix).HasMaxLength(16).IsRequired();
        builder.Property(e => e.Label).HasMaxLength(100);
        builder.HasIndex(e => e.CodeHash).IsUnique();

        builder.HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(e => e.CreatedByUserId)
            .OnDelete(DeleteBehavior.Restrict);

        builder.HasOne(e => e.ConsumedByWorker)
            .WithMany()
            .HasForeignKey(e => e.ConsumedByWorkerId)
            .OnDelete(DeleteBehavior.SetNull);
    }
}