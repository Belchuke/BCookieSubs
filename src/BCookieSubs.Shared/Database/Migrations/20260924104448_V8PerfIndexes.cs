using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    public partial class V8PerfIndexes : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_application_logs_Type",
                table: "application_logs",
                column: "Type");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_application_logs_Type",
                table: "application_logs");
        }
    }
}
