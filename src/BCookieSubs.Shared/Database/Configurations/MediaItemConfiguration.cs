using BCookieSubs.Shared.Database.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BCookieSubs.Shared.Database.Configurations;

public class MediaItemConfiguration : IEntityTypeConfiguration<MediaItem>
{
    public void Configure(EntityTypeBuilder<MediaItem> builder)
    {
        builder.ToTable("media_items");

        builder.Property(m => m.Title).HasMaxLength(300).IsRequired();
        builder.Property(m => m.OriginalTitle).HasMaxLength(300);
        builder.Property(m => m.TheMovieDbId).HasMaxLength(32);
        builder.Property(m => m.PhotoPath).HasMaxLength(200);
        builder.Property(m => m.Type).HasConversion<string>().HasMaxLength(16);

        builder.Property(m => m.Genres).HasJsonbConversion();

        builder.HasIndex(m => m.TheMovieDbId);
        builder.HasIndex(m => new { m.Title, m.Type, m.Year });
    }
}