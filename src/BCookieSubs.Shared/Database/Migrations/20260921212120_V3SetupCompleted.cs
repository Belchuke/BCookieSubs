using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    public partial class V3SetupCompleted : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "SetupCompleted",
                table: "application_config",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "SetupCompleted",
                table: "application_config");
        }
    }
}
