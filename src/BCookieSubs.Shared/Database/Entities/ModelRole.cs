using BCookieSubs.Shared.Database.Enums;

namespace BCookieSubs.Shared.Database.Entities;

public class ModelRole
{
    public long Id { get; set; }
    public long ModelId { get; set; }
    public Model Model { get; set; } = null!;
    public ModelRoleKind Role { get; set; }

    public DateTime? DeletedAt { get; set; }
    public DateTime CreatedAt { get; set; }
}