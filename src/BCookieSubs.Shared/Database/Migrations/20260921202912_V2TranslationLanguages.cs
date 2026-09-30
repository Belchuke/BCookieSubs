using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    public partial class V2TranslationLanguages : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "config_translation_languages",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    LanguageId = table.Column<long>(type: "bigint", nullable: false),
                    Position = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_config_translation_languages", x => x.Id);
                    table.ForeignKey(
                        name: "FK_config_translation_languages_languages_LanguageId",
                        column: x => x.LanguageId,
                        principalTable: "languages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "user_config_translation_languages",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    LanguageId = table.Column<long>(type: "bigint", nullable: false),
                    Position = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_user_config_translation_languages", x => x.Id);
                    table.ForeignKey(
                        name: "FK_user_config_translation_languages_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_user_config_translation_languages_languages_LanguageId",
                        column: x => x.LanguageId,
                        principalTable: "languages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_library_path_items_LibraryPathId_Status",
                table: "library_path_items",
                columns: new[] { "LibraryPathId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_config_translation_languages_LanguageId",
                table: "config_translation_languages",
                column: "LanguageId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_user_config_translation_languages_LanguageId",
                table: "user_config_translation_languages",
                column: "LanguageId");

            migrationBuilder.CreateIndex(
                name: "IX_user_config_translation_languages_UserId_LanguageId",
                table: "user_config_translation_languages",
                columns: new[] { "UserId", "LanguageId" },
                unique: true);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "config_translation_languages");

            migrationBuilder.DropTable(
                name: "user_config_translation_languages");

            migrationBuilder.DropIndex(
                name: "IX_library_path_items_LibraryPathId_Status",
                table: "library_path_items");
        }
    }
}
