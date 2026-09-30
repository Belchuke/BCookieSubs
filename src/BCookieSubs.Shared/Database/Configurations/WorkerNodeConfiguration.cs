using System.Text.Json;
using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BCookieSubs.Shared.Database.Configurations;

public class WorkerNodeConfiguration : IEntityTypeConfiguration<WorkerNode>
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public void Configure(Microsoft.EntityFrameworkCore.Metadata.Builders.EntityTypeBuilder<WorkerNode> builder)
    {
        builder.ToTable("worker_nodes");

        builder.Property(w => w.Name).HasMaxLength(100).IsRequired();
        builder.HasIndex(w => w.Name).IsUnique();
        builder.Property(w => w.MachineIdentifier).HasMaxLength(100);
        builder.Property(w => w.WorkerVersion).HasMaxLength(32);

        builder.Property(w => w.ReportedCapabilities)
            .HasColumnType("jsonb")
            .HasConversion(
                new ValueConverter<List<string>, string>(
                    v => JsonSerializer.Serialize(v, JsonOptions),
                    v => JsonSerializer.Deserialize<List<string>>(v, JsonOptions) ?? new List<string>()),
                new ValueComparer<List<string>>(
                    (a, b) => a != null && b != null && a.SequenceEqual(b),
                    v => v.Aggregate(0, (h, s) => HashCode.Combine(h, s)),
                    v => v.ToList()));

        builder.Property(w => w.AllowedCapabilities)
            .HasColumnType("jsonb")
            .HasConversion(
                new ValueConverter<List<string>, string>(
                    v => JsonSerializer.Serialize(v, JsonOptions),
                    v => JsonSerializer.Deserialize<List<string>>(v, JsonOptions) ?? new List<string>()),
                new ValueComparer<List<string>>(
                    (a, b) => a != null && b != null && a.SequenceEqual(b),
                    v => v.Aggregate(0, (h, s) => HashCode.Combine(h, s)),
                    v => v.ToList()));

        builder.OwnsOne(w => w.Hardware, hw =>
        {
            hw.ToJson();
            hw.Property(x => x.OperatingSystem).HasMaxLength(100);
            hw.Property(x => x.Architecture).HasMaxLength(32);
            hw.Property(x => x.CpuModel).HasMaxLength(200);
            hw.Property(x => x.GpuVendor).HasMaxLength(60);
            hw.Property(x => x.GpuModel).HasMaxLength(120);
            hw.Property(x => x.PythonVersion).HasMaxLength(32);
        });
    }
}