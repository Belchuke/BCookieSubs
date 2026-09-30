using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    public partial class V3ConfigLegacyColumns : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "ClearLogs",
                table: "application_config",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<int>(
                name: "ClearLogsOlderThanDays",
                table: "application_config",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.AddColumn<bool>(
                name: "ScheduleConfigured",
                table: "application_config",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "WhisperModelRootPath",
                table: "application_config",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "WhisperRunAsSeparateTask",
                table: "application_config",
                type: "boolean",
                nullable: false,
                defaultValue: false);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ClearLogs",
                table: "application_config");

            migrationBuilder.DropColumn(
                name: "ClearLogsOlderThanDays",
                table: "application_config");

            migrationBuilder.DropColumn(
                name: "ScheduleConfigured",
                table: "application_config");

            migrationBuilder.DropColumn(
                name: "WhisperModelRootPath",
                table: "application_config");

            migrationBuilder.DropColumn(
                name: "WhisperRunAsSeparateTask",
                table: "application_config");
        }
    }
}
