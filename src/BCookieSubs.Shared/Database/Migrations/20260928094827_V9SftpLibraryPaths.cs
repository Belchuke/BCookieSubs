using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    public partial class V9SftpLibraryPaths : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_library_paths_Path",
                table: "library_paths");

            migrationBuilder.AddColumn<string>(
                name: "SftpAuthMode",
                table: "library_paths",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValueSql: "'Password'");

            migrationBuilder.AddColumn<string>(
                name: "SftpHost",
                table: "library_paths",
                type: "character varying(255)",
                maxLength: 255,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SftpHostKeyFingerprint",
                table: "library_paths",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "SftpPort",
                table: "library_paths",
                type: "integer",
                nullable: false,
                defaultValue: 22);

            migrationBuilder.AddColumn<string>(
                name: "SftpUsername",
                table: "library_paths",
                type: "character varying(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Storage",
                table: "library_paths",
                type: "character varying(16)",
                maxLength: 16,
                nullable: false,
                defaultValueSql: "'Local'");

            migrationBuilder.CreateIndex(
                name: "IX_library_paths_Path",
                table: "library_paths",
                column: "Path",
                unique: true,
                filter: "\"Storage\" = 'Local'");

            migrationBuilder.CreateIndex(
                name: "IX_library_paths_SftpHost_Path",
                table: "library_paths",
                columns: new[] { "SftpHost", "Path" },
                unique: true,
                filter: "\"Storage\" = 'Sftp'");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_library_paths_Path",
                table: "library_paths");

            migrationBuilder.DropIndex(
                name: "IX_library_paths_SftpHost_Path",
                table: "library_paths");

            migrationBuilder.DropColumn(
                name: "SftpAuthMode",
                table: "library_paths");

            migrationBuilder.DropColumn(
                name: "SftpHost",
                table: "library_paths");

            migrationBuilder.DropColumn(
                name: "SftpHostKeyFingerprint",
                table: "library_paths");

            migrationBuilder.DropColumn(
                name: "SftpPort",
                table: "library_paths");

            migrationBuilder.DropColumn(
                name: "SftpUsername",
                table: "library_paths");

            migrationBuilder.DropColumn(
                name: "Storage",
                table: "library_paths");

            migrationBuilder.CreateIndex(
                name: "IX_library_paths_Path",
                table: "library_paths",
                column: "Path",
                unique: true);
        }
    }
}
