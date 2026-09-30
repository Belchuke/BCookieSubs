using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BCookieSubs.Shared.Database.Configurations;

public static class JsonbExtensions
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static PropertyBuilder<T> HasJsonbConversion<T>(this PropertyBuilder<T> builder) where T : class, new()
    {
        return builder
            .HasColumnType("jsonb")
            .HasConversion(
                new ValueConverter<T, string>(
                    v => JsonSerializer.Serialize(v, JsonOptions),
                    v => JsonSerializer.Deserialize<T>(v, JsonOptions) ?? new T()),
                new ValueComparer<T>(
                    (a, b) => JsonSerializer.Serialize(a, JsonOptions) == JsonSerializer.Serialize(b, JsonOptions),
                    v => JsonSerializer.Serialize(v, JsonOptions).GetHashCode(),
                    v => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(v, JsonOptions), JsonOptions) ?? new T()));
    }
}