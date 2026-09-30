using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    public partial class V8PipelineConcurrency : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql("""
                UPDATE worker_jobs SET "Status" = 'Cancelled',
                       "ErrorMessage" = 'Cancelled: superseded by duplicate queued job (dedupe)',
                       "UpdatedAt" = now()
                WHERE "Status" IN ('Queued', 'Running')
                  AND EXISTS (
                    SELECT 1 FROM worker_jobs w2
                    WHERE w2."JobType" = worker_jobs."JobType"
                      AND w2."SubjectType" IS NOT DISTINCT FROM worker_jobs."SubjectType"
                      AND w2."SubjectId" IS NOT DISTINCT FROM worker_jobs."SubjectId"
                      AND w2."Status" IN ('Queued', 'Running')
                      AND w2."Id" < worker_jobs."Id");
                """);

            migrationBuilder.CreateIndex(
                name: "IX_worker_jobs_JobType_SubjectType_SubjectId",
                table: "worker_jobs",
                columns: new[] { "JobType", "SubjectType", "SubjectId" },
                unique: true,
                filter: "\"Status\" IN ('Queued', 'Running')");
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_worker_jobs_JobType_SubjectType_SubjectId",
                table: "worker_jobs");
        }
    }
}
