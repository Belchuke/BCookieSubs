using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    public partial class V3UserSoftDelete : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<DateTime>(
                name: "DeletedAt",
                table: "AspNetUsers",
                type: "timestamp with time zone",
                nullable: true);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "DeletedAt",
                table: "AspNetUsers");
        }
    }
}
