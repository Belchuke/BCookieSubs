using System;
using Microsoft.EntityFrameworkCore.Migrations;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    public partial class V2DomainModel : Migration
    {
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<bool>(
                name: "HasSeenTutorial",
                table: "AspNetUsers",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "Language",
                table: "AspNetUsers",
                type: "character varying(35)",
                maxLength: 35,
                nullable: true);

            migrationBuilder.AddColumn<long>(
                name: "SelectedThemeId",
                table: "AspNetUsers",
                type: "bigint",
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "ShowPosters",
                table: "AspNetUsers",
                type: "boolean",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<string>(
                name: "Description",
                table: "AspNetRoles",
                type: "character varying(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Level",
                table: "AspNetRoles",
                type: "integer",
                nullable: false,
                defaultValue: 0);

            migrationBuilder.CreateTable(
                name: "app_secrets",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Key = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Ciphertext = table.Column<byte[]>(type: "bytea", nullable: false),
                    Nonce = table.Column<byte[]>(type: "bytea", nullable: false),
                    Tag = table.Column<byte[]>(type: "bytea", nullable: false),
                    Algorithm = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    SetByEnv = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_app_secrets", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "application_logs",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Level = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Type = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    EntityType = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    EntityId = table.Column<long>(type: "bigint", nullable: true),
                    Message = table.Column<string>(type: "text", nullable: false),
                    Metadata = table.Column<string>(type: "jsonb", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_application_logs", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "languages",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Iso639 = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    Iso6392B = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    Locale = table.Column<string>(type: "character varying(35)", maxLength: 35, nullable: false),
                    Flag = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_languages", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "media_items",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Type = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Title = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    OriginalTitle = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    Year = table.Column<int>(type: "integer", nullable: true),
                    TheMovieDbId = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    IsAnime = table.Column<bool>(type: "boolean", nullable: true),
                    Genres = table.Column<string>(type: "jsonb", nullable: false),
                    PhotoPath = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_media_items", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "permissions",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Key = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Label = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Description = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    Category = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_permissions", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "prompts",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Kind = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Active = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_prompts", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "recommended_models",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Size = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    ParameterSize = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    BaseUrl = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Roles = table.Column<string>(type: "jsonb", nullable: false),
                    RequireOllamaSubscription = table.Column<bool>(type: "boolean", nullable: false),
                    Score = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_recommended_models", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "schedules",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    TaskName = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    DayOfTheWeek = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    StartTime = table.Column<TimeSpan>(type: "time", nullable: false),
                    DurationMinutes = table.Column<int>(type: "integer", nullable: false),
                    RepeatUnit = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    RepeatInterval = table.Column<int>(type: "integer", nullable: false),
                    LastRunAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    FirstStartAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_schedules", x => x.Id);
                    table.CheckConstraint("CK_schedules_duration_positive", "\"DurationMinutes\" > 0");
                    table.CheckConstraint("CK_schedules_interval_positive", "\"RepeatInterval\" > 0");
                });

            migrationBuilder.CreateTable(
                name: "themes",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    Bg = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Surface = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Surface2 = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Surface3 = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    BorderColor = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    TextColor = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    TextDim = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    TextHint = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Accent = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    AccentDim = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Success = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    SuccessDim = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Warning = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    WarningDim = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    Error = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    ErrorDim = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    InfoDim = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    IsPublic = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedByUserId = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_themes", x => x.Id);
                    table.ForeignKey(
                        name: "FK_themes_AspNetUsers_CreatedByUserId",
                        column: x => x.CreatedByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "worker_jobs",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    JobType = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: false),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Priority = table.Column<int>(type: "integer", nullable: false),
                    RequiredCapability = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    Payload = table.Column<string>(type: "jsonb", nullable: true),
                    Result = table.Column<string>(type: "jsonb", nullable: true),
                    SubjectType = table.Column<string>(type: "character varying(50)", maxLength: 50, nullable: true),
                    SubjectId = table.Column<long>(type: "bigint", nullable: true),
                    DisplayName = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: true),
                    CreatedByUserId = table.Column<long>(type: "bigint", nullable: true),
                    ClaimedByWorkerId = table.Column<long>(type: "bigint", nullable: true),
                    ClaimedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    HeartbeatAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    LeaseExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    RetryCount = table.Column<int>(type: "integer", nullable: false),
                    MaxRetries = table.Column<int>(type: "integer", nullable: false),
                    NextRetryAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    ErrorCode = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    ErrorMessage = table.Column<string>(type: "character varying(1000)", maxLength: 1000, nullable: true),
                    Progress = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    FinishedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_worker_jobs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_worker_jobs_AspNetUsers_CreatedByUserId",
                        column: x => x.CreatedByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_worker_jobs_worker_nodes_ClaimedByWorkerId",
                        column: x => x.ClaimedByWorkerId,
                        principalTable: "worker_nodes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "library_paths",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Enabled = table.Column<bool>(type: "boolean", nullable: false),
                    Path = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    AutoTranslate = table.Column<bool>(type: "boolean", nullable: false),
                    AutoExtract = table.Column<bool>(type: "boolean", nullable: false),
                    SourceLanguageId = table.Column<long>(type: "bigint", nullable: false),
                    LastRunAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    State = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Type = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    InitialScanCompleted = table.Column<bool>(type: "boolean", nullable: false),
                    ScanMode = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ScanRepeatInterval = table.Column<int>(type: "integer", nullable: false),
                    ScanRepeatUnit = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ScanDayOfWeek = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    ScanStartTime = table.Column<TimeSpan>(type: "time", nullable: false),
                    ScanDurationMinutes = table.Column<int>(type: "integer", nullable: false),
                    ScanFirstStartAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    InitialScanDurationMs = table.Column<long>(type: "bigint", nullable: true),
                    PostInitialScanCount = table.Column<int>(type: "integer", nullable: false),
                    PostInitialScanTotalMs = table.Column<long>(type: "bigint", nullable: false),
                    LastScanDurationMs = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_library_paths", x => x.Id);
                    table.ForeignKey(
                        name: "FK_library_paths_languages_SourceLanguageId",
                        column: x => x.SourceLanguageId,
                        principalTable: "languages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "prompt_versions",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    PromptId = table.Column<long>(type: "bigint", nullable: false),
                    Version = table.Column<int>(type: "integer", nullable: false),
                    PromptText = table.Column<string>(type: "text", nullable: false),
                    Active = table.Column<bool>(type: "boolean", nullable: false),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_prompt_versions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_prompt_versions_prompts_PromptId",
                        column: x => x.PromptId,
                        principalTable: "prompts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "models",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    Name = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    ModelName = table.Column<string>(type: "character varying(200)", maxLength: 200, nullable: false),
                    Size = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    ParameterSize = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    ModelUpdatedAt = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    CloseAfterUse = table.Column<bool>(type: "boolean", nullable: false),
                    Active = table.Column<bool>(type: "boolean", nullable: false),
                    Provider = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    BaseUrl = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    RecommendedModelId = table.Column<long>(type: "bigint", nullable: true),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_models", x => x.Id);
                    table.ForeignKey(
                        name: "FK_models_recommended_models_RecommendedModelId",
                        column: x => x.RecommendedModelId,
                        principalTable: "recommended_models",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "application_config",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false),
                    DefaultChunkSize = table.Column<int>(type: "integer", nullable: false),
                    MaxRetriesPerChunk = table.Column<int>(type: "integer", nullable: false),
                    FinishSingleSubtitleFirst = table.Column<bool>(type: "boolean", nullable: false),
                    DeleteNotCancel = table.Column<bool>(type: "boolean", nullable: false),
                    ShowPosters = table.Column<bool>(type: "boolean", nullable: false),
                    NameDetectionActive = table.Column<bool>(type: "boolean", nullable: false),
                    TheMovieDbActive = table.Column<bool>(type: "boolean", nullable: false),
                    ScanLibraryPaths = table.Column<bool>(type: "boolean", nullable: false),
                    RootLibraryPath = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    SelectedThemeId = table.Column<long>(type: "bigint", nullable: true),
                    DefaultLanguage = table.Column<string>(type: "character varying(35)", maxLength: 35, nullable: false),
                    ThaiAssFont = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    SessionTimeoutMinutes = table.Column<int>(type: "integer", nullable: false),
                    WhisperModel = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: false),
                    WhisperTimestampsLength = table.Column<int>(type: "integer", nullable: false),
                    WhisperUseCuda = table.Column<bool>(type: "boolean", nullable: false),
                    WhisperEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    LogRetentionEnabled = table.Column<bool>(type: "boolean", nullable: false),
                    LogRetentionDays = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_application_config", x => x.Id);
                    table.ForeignKey(
                        name: "FK_application_config_themes_SelectedThemeId",
                        column: x => x.SelectedThemeId,
                        principalTable: "themes",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "library_path_items",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    LibraryPathId = table.Column<long>(type: "bigint", nullable: false),
                    MediaItemId = table.Column<long>(type: "bigint", nullable: true),
                    Status = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    Season = table.Column<int>(type: "integer", nullable: true),
                    Episode = table.Column<int>(type: "integer", nullable: true),
                    IsExtra = table.Column<bool>(type: "boolean", nullable: false),
                    Path = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    ExtractFileName = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_library_path_items", x => x.Id);
                    table.ForeignKey(
                        name: "FK_library_path_items_library_paths_LibraryPathId",
                        column: x => x.LibraryPathId,
                        principalTable: "library_paths",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_library_path_items_media_items_MediaItemId",
                        column: x => x.MediaItemId,
                        principalTable: "media_items",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "model_roles",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    ModelId = table.Column<long>(type: "bigint", nullable: false),
                    Role = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_model_roles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_model_roles_models_ModelId",
                        column: x => x.ModelId,
                        principalTable: "models",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "prompt_stats",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    PromptId = table.Column<long>(type: "bigint", nullable: false),
                    PromptVersionId = table.Column<long>(type: "bigint", nullable: false),
                    ModelId = table.Column<long>(type: "bigint", nullable: false),
                    LanguageId = table.Column<long>(type: "bigint", nullable: true),
                    RequestCount = table.Column<int>(type: "integer", nullable: false),
                    FailedCount = table.Column<int>(type: "integer", nullable: false),
                    SuccessCount = table.Column<int>(type: "integer", nullable: false),
                    SelectedCount = table.Column<int>(type: "integer", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_prompt_stats", x => x.Id);
                    table.ForeignKey(
                        name: "FK_prompt_stats_languages_LanguageId",
                        column: x => x.LanguageId,
                        principalTable: "languages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_prompt_stats_models_ModelId",
                        column: x => x.ModelId,
                        principalTable: "models",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_prompt_stats_prompt_versions_PromptVersionId",
                        column: x => x.PromptVersionId,
                        principalTable: "prompt_versions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_prompt_stats_prompts_PromptId",
                        column: x => x.PromptId,
                        principalTable: "prompts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "library_path_item_blacklist",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    LibraryPathItemId = table.Column<long>(type: "bigint", nullable: false),
                    BlacklistedByUserId = table.Column<long>(type: "bigint", nullable: true),
                    Reason = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_library_path_item_blacklist", x => x.Id);
                    table.ForeignKey(
                        name: "FK_library_path_item_blacklist_AspNetUsers_BlacklistedByUserId",
                        column: x => x.BlacklistedByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_library_path_item_blacklist_library_path_items_LibraryPathI~",
                        column: x => x.LibraryPathItemId,
                        principalTable: "library_path_items",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "library_path_item_candidates",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    LibraryPathItemId = table.Column<long>(type: "bigint", nullable: false),
                    Path = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    MediaItemId = table.Column<long>(type: "bigint", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_library_path_item_candidates", x => x.Id);
                    table.ForeignKey(
                        name: "FK_library_path_item_candidates_library_path_items_LibraryPath~",
                        column: x => x.LibraryPathItemId,
                        principalTable: "library_path_items",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_library_path_item_candidates_media_items_MediaItemId",
                        column: x => x.MediaItemId,
                        principalTable: "media_items",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "library_path_item_subtitle_sources",
                columns: table => new
                {
                    LibraryPathItemId = table.Column<long>(type: "bigint", nullable: false),
                    Sources = table.Column<string>(type: "jsonb", nullable: false),
                    FileMtimeMs = table.Column<long>(type: "bigint", nullable: false),
                    FileSize = table.Column<long>(type: "bigint", nullable: false),
                    ScannedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_library_path_item_subtitle_sources", x => x.LibraryPathItemId);
                    table.ForeignKey(
                        name: "FK_library_path_item_subtitle_sources_library_path_items_Libra~",
                        column: x => x.LibraryPathItemId,
                        principalTable: "library_path_items",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "subtitles",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    SourceLanguageId = table.Column<long>(type: "bigint", nullable: false),
                    MediaItemId = table.Column<long>(type: "bigint", nullable: true),
                    LibraryPathItemId = table.Column<long>(type: "bigint", nullable: true),
                    Name = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    OriginalFileHash = table.Column<string>(type: "character varying(64)", maxLength: 64, nullable: false),
                    OriginalFileName = table.Column<string>(type: "character varying(300)", maxLength: 300, nullable: false),
                    OriginalText = table.Column<string>(type: "text", nullable: false),
                    SourceFormat = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: false),
                    TextOrigin = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    OriginalSourceFormat = table.Column<string>(type: "character varying(8)", maxLength: 8, nullable: true),
                    Priority = table.Column<int>(type: "integer", nullable: false),
                    WhisperPriority = table.Column<int>(type: "integer", nullable: true),
                    Hide = table.Column<bool>(type: "boolean", nullable: false),
                    Source = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: true),
                    SourcePath = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    MediaPath = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    WhisperTranscriptionState = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: true),
                    WhisperModel = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    WhisperTimestampsLength = table.Column<int>(type: "integer", nullable: true),
                    WhisperUseCuda = table.Column<bool>(type: "boolean", nullable: true),
                    Season = table.Column<int>(type: "integer", nullable: true),
                    Episode = table.Column<int>(type: "integer", nullable: true),
                    WhisperProgress = table.Column<int>(type: "integer", nullable: false),
                    WhisperPositionMs = table.Column<long>(type: "bigint", nullable: false),
                    WhisperDurationMs = table.Column<long>(type: "bigint", nullable: false),
                    WhisperResumeSrt = table.Column<string>(type: "text", nullable: true),
                    WhisperResumeMs = table.Column<long>(type: "bigint", nullable: false),
                    FinishedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CancelledAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CancelledByUserId = table.Column<long>(type: "bigint", nullable: true),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DeletedByUserId = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_subtitles", x => x.Id);
                    table.ForeignKey(
                        name: "FK_subtitles_AspNetUsers_CancelledByUserId",
                        column: x => x.CancelledByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_subtitles_AspNetUsers_DeletedByUserId",
                        column: x => x.DeletedByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_subtitles_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_subtitles_languages_SourceLanguageId",
                        column: x => x.SourceLanguageId,
                        principalTable: "languages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_subtitles_library_path_items_LibraryPathItemId",
                        column: x => x.LibraryPathItemId,
                        principalTable: "library_path_items",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_subtitles_media_items_MediaItemId",
                        column: x => x.MediaItemId,
                        principalTable: "media_items",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "translated_library_items",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    LibraryPathItemId = table.Column<long>(type: "bigint", nullable: false),
                    LanguageId = table.Column<long>(type: "bigint", nullable: false),
                    DetectedAtPath = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    FileMtimeMs = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_translated_library_items", x => x.Id);
                    table.ForeignKey(
                        name: "FK_translated_library_items_languages_LanguageId",
                        column: x => x.LanguageId,
                        principalTable: "languages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_translated_library_items_library_path_items_LibraryPathItem~",
                        column: x => x.LibraryPathItemId,
                        principalTable: "library_path_items",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "exported_subtitle_files",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    LibraryPathId = table.Column<long>(type: "bigint", nullable: false),
                    Path = table.Column<string>(type: "character varying(500)", maxLength: 500, nullable: false),
                    SubtitleId = table.Column<long>(type: "bigint", nullable: true),
                    IsWhisper = table.Column<bool>(type: "boolean", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_exported_subtitle_files", x => x.Id);
                    table.ForeignKey(
                        name: "FK_exported_subtitle_files_library_paths_LibraryPathId",
                        column: x => x.LibraryPathId,
                        principalTable: "library_paths",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_exported_subtitle_files_subtitles_SubtitleId",
                        column: x => x.SubtitleId,
                        principalTable: "subtitles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "subtitle_jobs",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    SubtitleId = table.Column<long>(type: "bigint", nullable: false),
                    UserId = table.Column<long>(type: "bigint", nullable: false),
                    TargetLanguageId = table.Column<long>(type: "bigint", nullable: false),
                    ChunkSetting = table.Column<int>(type: "integer", nullable: false),
                    TotalChunks = table.Column<int>(type: "integer", nullable: false),
                    CurrentChunk = table.Column<int>(type: "integer", nullable: false),
                    Season = table.Column<int>(type: "integer", nullable: true),
                    Episode = table.Column<int>(type: "integer", nullable: true),
                    Status = table.Column<string>(type: "character varying(16)", maxLength: 16, nullable: false),
                    Priority = table.Column<int>(type: "integer", nullable: false),
                    TranslatedText = table.Column<string>(type: "text", nullable: true),
                    OutputFilePath = table.Column<string>(type: "text", nullable: true),
                    OutputHash = table.Column<string>(type: "text", nullable: true),
                    FinishedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CancelledAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CancelledByUserId = table.Column<long>(type: "bigint", nullable: true),
                    DeletedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    DeletedByUserId = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_subtitle_jobs", x => x.Id);
                    table.ForeignKey(
                        name: "FK_subtitle_jobs_AspNetUsers_CancelledByUserId",
                        column: x => x.CancelledByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_subtitle_jobs_AspNetUsers_DeletedByUserId",
                        column: x => x.DeletedByUserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_subtitle_jobs_AspNetUsers_UserId",
                        column: x => x.UserId,
                        principalTable: "AspNetUsers",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_subtitle_jobs_languages_TargetLanguageId",
                        column: x => x.TargetLanguageId,
                        principalTable: "languages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_subtitle_jobs_subtitles_SubtitleId",
                        column: x => x.SubtitleId,
                        principalTable: "subtitles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateTable(
                name: "judge_evaluations",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    SubtitleChunkId = table.Column<long>(type: "bigint", nullable: false),
                    ModelId = table.Column<long>(type: "bigint", nullable: true),
                    JudgeInput = table.Column<string>(type: "text", nullable: true),
                    JudgeReason = table.Column<string>(type: "text", nullable: true),
                    SelectedCandidateId = table.Column<long>(type: "bigint", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_judge_evaluations", x => x.Id);
                    table.ForeignKey(
                        name: "FK_judge_evaluations_models_ModelId",
                        column: x => x.ModelId,
                        principalTable: "models",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "subtitle_chunk_candidates",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    SubtitleChunkId = table.Column<long>(type: "bigint", nullable: false),
                    ModelId = table.Column<long>(type: "bigint", nullable: true),
                    PromptId = table.Column<long>(type: "bigint", nullable: true),
                    PromptVersionId = table.Column<long>(type: "bigint", nullable: true),
                    TranslatedText = table.Column<string>(type: "text", nullable: true),
                    Status = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    ValidationPassed = table.Column<bool>(type: "boolean", nullable: true),
                    Selected = table.Column<bool>(type: "boolean", nullable: false),
                    RetryCount = table.Column<int>(type: "integer", nullable: false),
                    DurationMs = table.Column<long>(type: "bigint", nullable: true),
                    ErrorMessage = table.Column<string>(type: "text", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_subtitle_chunk_candidates", x => x.Id);
                    table.ForeignKey(
                        name: "FK_subtitle_chunk_candidates_models_ModelId",
                        column: x => x.ModelId,
                        principalTable: "models",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_subtitle_chunk_candidates_prompt_versions_PromptVersionId",
                        column: x => x.PromptVersionId,
                        principalTable: "prompt_versions",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_subtitle_chunk_candidates_prompts_PromptId",
                        column: x => x.PromptId,
                        principalTable: "prompts",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                });

            migrationBuilder.CreateTable(
                name: "subtitle_chunks",
                columns: table => new
                {
                    Id = table.Column<long>(type: "bigint", nullable: false)
                        .Annotation("Npgsql:ValueGenerationStrategy", NpgsqlValueGenerationStrategy.IdentityByDefaultColumn),
                    SubtitleId = table.Column<long>(type: "bigint", nullable: false),
                    SubtitleJobId = table.Column<long>(type: "bigint", nullable: false),
                    TargetLanguageId = table.Column<long>(type: "bigint", nullable: false),
                    ChunkIndex = table.Column<int>(type: "integer", nullable: false),
                    SrtIdFrom = table.Column<int>(type: "integer", nullable: false),
                    SrtIdTo = table.Column<int>(type: "integer", nullable: false),
                    Status = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    JudgeModelId = table.Column<long>(type: "bigint", nullable: true),
                    JudgeReason = table.Column<string>(type: "text", nullable: true),
                    SelectedCandidateId = table.Column<long>(type: "bigint", nullable: true),
                    DurationMs = table.Column<long>(type: "bigint", nullable: true),
                    RetryCount = table.Column<int>(type: "integer", nullable: false),
                    ErrorMessage = table.Column<string>(type: "text", nullable: true),
                    StartedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    FinishedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: true),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_subtitle_chunks", x => x.Id);
                    table.ForeignKey(
                        name: "FK_subtitle_chunks_languages_TargetLanguageId",
                        column: x => x.TargetLanguageId,
                        principalTable: "languages",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_subtitle_chunks_models_JudgeModelId",
                        column: x => x.JudgeModelId,
                        principalTable: "models",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_subtitle_chunks_subtitle_chunk_candidates_SelectedCandidate~",
                        column: x => x.SelectedCandidateId,
                        principalTable: "subtitle_chunk_candidates",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.SetNull);
                    table.ForeignKey(
                        name: "FK_subtitle_chunks_subtitle_jobs_SubtitleJobId",
                        column: x => x.SubtitleJobId,
                        principalTable: "subtitle_jobs",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                    table.ForeignKey(
                        name: "FK_subtitle_chunks_subtitles_SubtitleId",
                        column: x => x.SubtitleId,
                        principalTable: "subtitles",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_AspNetUsers_SelectedThemeId",
                table: "AspNetUsers",
                column: "SelectedThemeId");

            migrationBuilder.CreateIndex(
                name: "IX_AspNetRoles_Level",
                table: "AspNetRoles",
                column: "Level",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_app_secrets_Key",
                table: "app_secrets",
                column: "Key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_application_config_SelectedThemeId",
                table: "application_config",
                column: "SelectedThemeId");

            migrationBuilder.CreateIndex(
                name: "IX_application_logs_CreatedAt",
                table: "application_logs",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_application_logs_EntityType_EntityId",
                table: "application_logs",
                columns: new[] { "EntityType", "EntityId" });

            migrationBuilder.CreateIndex(
                name: "IX_exported_subtitle_files_LibraryPathId_Path",
                table: "exported_subtitle_files",
                columns: new[] { "LibraryPathId", "Path" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_exported_subtitle_files_SubtitleId",
                table: "exported_subtitle_files",
                column: "SubtitleId");

            migrationBuilder.CreateIndex(
                name: "IX_judge_evaluations_CreatedAt",
                table: "judge_evaluations",
                column: "CreatedAt");

            migrationBuilder.CreateIndex(
                name: "IX_judge_evaluations_ModelId_CreatedAt",
                table: "judge_evaluations",
                columns: new[] { "ModelId", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_judge_evaluations_SelectedCandidateId",
                table: "judge_evaluations",
                column: "SelectedCandidateId");

            migrationBuilder.CreateIndex(
                name: "IX_judge_evaluations_SubtitleChunkId",
                table: "judge_evaluations",
                column: "SubtitleChunkId");

            migrationBuilder.CreateIndex(
                name: "IX_languages_Iso639_Locale",
                table: "languages",
                columns: new[] { "Iso639", "Locale" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_library_path_item_blacklist_BlacklistedByUserId",
                table: "library_path_item_blacklist",
                column: "BlacklistedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_library_path_item_blacklist_LibraryPathItemId",
                table: "library_path_item_blacklist",
                column: "LibraryPathItemId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_library_path_item_candidates_LibraryPathItemId_MediaItemId",
                table: "library_path_item_candidates",
                columns: new[] { "LibraryPathItemId", "MediaItemId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_library_path_item_candidates_MediaItemId",
                table: "library_path_item_candidates",
                column: "MediaItemId");

            migrationBuilder.CreateIndex(
                name: "IX_library_path_items_ExtractFileName",
                table: "library_path_items",
                column: "ExtractFileName");

            migrationBuilder.CreateIndex(
                name: "IX_library_path_items_LibraryPathId_Path",
                table: "library_path_items",
                columns: new[] { "LibraryPathId", "Path" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_library_path_items_MediaItemId",
                table: "library_path_items",
                column: "MediaItemId");

            migrationBuilder.CreateIndex(
                name: "IX_library_paths_Name",
                table: "library_paths",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_library_paths_Path",
                table: "library_paths",
                column: "Path",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_library_paths_SourceLanguageId",
                table: "library_paths",
                column: "SourceLanguageId");

            migrationBuilder.CreateIndex(
                name: "IX_media_items_TheMovieDbId",
                table: "media_items",
                column: "TheMovieDbId");

            migrationBuilder.CreateIndex(
                name: "IX_media_items_Title_Type_Year",
                table: "media_items",
                columns: new[] { "Title", "Type", "Year" });

            migrationBuilder.CreateIndex(
                name: "IX_model_roles_ModelId_Role",
                table: "model_roles",
                columns: new[] { "ModelId", "Role" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_models_ModelName_ModelUpdatedAt",
                table: "models",
                columns: new[] { "ModelName", "ModelUpdatedAt" },
                unique: true)
                .Annotation("Npgsql:NullsDistinct", false);

            migrationBuilder.CreateIndex(
                name: "IX_models_RecommendedModelId",
                table: "models",
                column: "RecommendedModelId");

            migrationBuilder.CreateIndex(
                name: "IX_permissions_Key",
                table: "permissions",
                column: "Key",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_prompt_stats_LanguageId",
                table: "prompt_stats",
                column: "LanguageId");

            migrationBuilder.CreateIndex(
                name: "IX_prompt_stats_ModelId",
                table: "prompt_stats",
                column: "ModelId");

            migrationBuilder.CreateIndex(
                name: "IX_prompt_stats_PromptId_PromptVersionId_ModelId_LanguageId",
                table: "prompt_stats",
                columns: new[] { "PromptId", "PromptVersionId", "ModelId", "LanguageId" },
                unique: true)
                .Annotation("Npgsql:NullsDistinct", false);

            migrationBuilder.CreateIndex(
                name: "IX_prompt_stats_PromptVersionId",
                table: "prompt_stats",
                column: "PromptVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_prompt_versions_PromptId_Version",
                table: "prompt_versions",
                columns: new[] { "PromptId", "Version" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_prompts_Name",
                table: "prompts",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_recommended_models_Name",
                table: "recommended_models",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunk_candidates_ModelId",
                table: "subtitle_chunk_candidates",
                column: "ModelId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunk_candidates_PromptId",
                table: "subtitle_chunk_candidates",
                column: "PromptId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunk_candidates_PromptVersionId",
                table: "subtitle_chunk_candidates",
                column: "PromptVersionId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunk_candidates_Status_UpdatedAt",
                table: "subtitle_chunk_candidates",
                columns: new[] { "Status", "UpdatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunk_candidates_SubtitleChunkId_ModelId_PromptVer~",
                table: "subtitle_chunk_candidates",
                columns: new[] { "SubtitleChunkId", "ModelId", "PromptVersionId" },
                unique: true)
                .Annotation("Npgsql:NullsDistinct", false);

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunks_JudgeModelId",
                table: "subtitle_chunks",
                column: "JudgeModelId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunks_SelectedCandidateId",
                table: "subtitle_chunks",
                column: "SelectedCandidateId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunks_Status_StartedAt",
                table: "subtitle_chunks",
                columns: new[] { "Status", "StartedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunks_SubtitleId",
                table: "subtitle_chunks",
                column: "SubtitleId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunks_SubtitleJobId_ChunkIndex",
                table: "subtitle_chunks",
                columns: new[] { "SubtitleJobId", "ChunkIndex" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_chunks_TargetLanguageId",
                table: "subtitle_chunks",
                column: "TargetLanguageId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_jobs_CancelledByUserId",
                table: "subtitle_jobs",
                column: "CancelledByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_jobs_DeletedByUserId",
                table: "subtitle_jobs",
                column: "DeletedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_jobs_Status_Priority",
                table: "subtitle_jobs",
                columns: new[] { "Status", "Priority" });

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_jobs_SubtitleId_TargetLanguageId",
                table: "subtitle_jobs",
                columns: new[] { "SubtitleId", "TargetLanguageId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_jobs_TargetLanguageId",
                table: "subtitle_jobs",
                column: "TargetLanguageId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitle_jobs_UserId",
                table: "subtitle_jobs",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_CancelledByUserId",
                table: "subtitles",
                column: "CancelledByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_DeletedByUserId",
                table: "subtitles",
                column: "DeletedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_LibraryPathItemId",
                table: "subtitles",
                column: "LibraryPathItemId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_MediaItemId",
                table: "subtitles",
                column: "MediaItemId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_OriginalFileHash",
                table: "subtitles",
                column: "OriginalFileHash");

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_SourceLanguageId",
                table: "subtitles",
                column: "SourceLanguageId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_Status_Priority",
                table: "subtitles",
                columns: new[] { "Status", "Priority" });

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_UserId",
                table: "subtitles",
                column: "UserId");

            migrationBuilder.CreateIndex(
                name: "IX_subtitles_WhisperTranscriptionState",
                table: "subtitles",
                column: "WhisperTranscriptionState");

            migrationBuilder.CreateIndex(
                name: "IX_themes_CreatedByUserId",
                table: "themes",
                column: "CreatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_themes_Name",
                table: "themes",
                column: "Name",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_translated_library_items_LanguageId",
                table: "translated_library_items",
                column: "LanguageId");

            migrationBuilder.CreateIndex(
                name: "IX_translated_library_items_LibraryPathItemId_LanguageId",
                table: "translated_library_items",
                columns: new[] { "LibraryPathItemId", "LanguageId" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_worker_jobs_ClaimedByWorkerId_Status",
                table: "worker_jobs",
                columns: new[] { "ClaimedByWorkerId", "Status" });

            migrationBuilder.CreateIndex(
                name: "IX_worker_jobs_CreatedByUserId",
                table: "worker_jobs",
                column: "CreatedByUserId");

            migrationBuilder.CreateIndex(
                name: "IX_worker_jobs_Status_Priority_CreatedAt",
                table: "worker_jobs",
                columns: new[] { "Status", "Priority", "CreatedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_worker_jobs_SubjectType_SubjectId",
                table: "worker_jobs",
                columns: new[] { "SubjectType", "SubjectId" });

            migrationBuilder.AddForeignKey(
                name: "FK_AspNetUsers_themes_SelectedThemeId",
                table: "AspNetUsers",
                column: "SelectedThemeId",
                principalTable: "themes",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_judge_evaluations_subtitle_chunk_candidates_SelectedCandida~",
                table: "judge_evaluations",
                column: "SelectedCandidateId",
                principalTable: "subtitle_chunk_candidates",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_judge_evaluations_subtitle_chunks_SubtitleChunkId",
                table: "judge_evaluations",
                column: "SubtitleChunkId",
                principalTable: "subtitle_chunks",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);

            migrationBuilder.AddForeignKey(
                name: "FK_subtitle_chunk_candidates_subtitle_chunks_SubtitleChunkId",
                table: "subtitle_chunk_candidates",
                column: "SubtitleChunkId",
                principalTable: "subtitle_chunks",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_AspNetUsers_themes_SelectedThemeId",
                table: "AspNetUsers");

            migrationBuilder.DropForeignKey(
                name: "FK_library_path_items_library_paths_LibraryPathId",
                table: "library_path_items");

            migrationBuilder.DropForeignKey(
                name: "FK_subtitle_chunks_subtitles_SubtitleId",
                table: "subtitle_chunks");

            migrationBuilder.DropForeignKey(
                name: "FK_subtitle_jobs_subtitles_SubtitleId",
                table: "subtitle_jobs");

            migrationBuilder.DropForeignKey(
                name: "FK_subtitle_chunk_candidates_models_ModelId",
                table: "subtitle_chunk_candidates");

            migrationBuilder.DropForeignKey(
                name: "FK_subtitle_chunks_models_JudgeModelId",
                table: "subtitle_chunks");

            migrationBuilder.DropForeignKey(
                name: "FK_subtitle_chunks_subtitle_chunk_candidates_SelectedCandidate~",
                table: "subtitle_chunks");

            migrationBuilder.DropTable(
                name: "app_secrets");

            migrationBuilder.DropTable(
                name: "application_config");

            migrationBuilder.DropTable(
                name: "application_logs");

            migrationBuilder.DropTable(
                name: "exported_subtitle_files");

            migrationBuilder.DropTable(
                name: "judge_evaluations");

            migrationBuilder.DropTable(
                name: "library_path_item_blacklist");

            migrationBuilder.DropTable(
                name: "library_path_item_candidates");

            migrationBuilder.DropTable(
                name: "library_path_item_subtitle_sources");

            migrationBuilder.DropTable(
                name: "model_roles");

            migrationBuilder.DropTable(
                name: "permissions");

            migrationBuilder.DropTable(
                name: "prompt_stats");

            migrationBuilder.DropTable(
                name: "schedules");

            migrationBuilder.DropTable(
                name: "translated_library_items");

            migrationBuilder.DropTable(
                name: "worker_jobs");

            migrationBuilder.DropTable(
                name: "themes");

            migrationBuilder.DropTable(
                name: "library_paths");

            migrationBuilder.DropTable(
                name: "subtitles");

            migrationBuilder.DropTable(
                name: "library_path_items");

            migrationBuilder.DropTable(
                name: "media_items");

            migrationBuilder.DropTable(
                name: "models");

            migrationBuilder.DropTable(
                name: "recommended_models");

            migrationBuilder.DropTable(
                name: "subtitle_chunk_candidates");

            migrationBuilder.DropTable(
                name: "prompt_versions");

            migrationBuilder.DropTable(
                name: "subtitle_chunks");

            migrationBuilder.DropTable(
                name: "prompts");

            migrationBuilder.DropTable(
                name: "subtitle_jobs");

            migrationBuilder.DropTable(
                name: "languages");

            migrationBuilder.DropIndex(
                name: "IX_AspNetUsers_SelectedThemeId",
                table: "AspNetUsers");

            migrationBuilder.DropIndex(
                name: "IX_AspNetRoles_Level",
                table: "AspNetRoles");

            migrationBuilder.DropColumn(
                name: "HasSeenTutorial",
                table: "AspNetUsers");

            migrationBuilder.DropColumn(
                name: "Language",
                table: "AspNetUsers");

            migrationBuilder.DropColumn(
                name: "SelectedThemeId",
                table: "AspNetUsers");

            migrationBuilder.DropColumn(
                name: "ShowPosters",
                table: "AspNetUsers");

            migrationBuilder.DropColumn(
                name: "Description",
                table: "AspNetRoles");

            migrationBuilder.DropColumn(
                name: "Level",
                table: "AspNetRoles");
        }
    }
}
