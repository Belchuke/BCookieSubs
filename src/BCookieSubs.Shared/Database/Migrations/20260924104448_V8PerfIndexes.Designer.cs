
using System;
using BCookieSubs.Shared.Database;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Npgsql.EntityFrameworkCore.PostgreSQL.Metadata;

#nullable disable

namespace BCookieSubs.Shared.Database.Migrations
{
    [DbContext(typeof(BCookieSubsDbContext))]
    [Migration("20260924104448_V8PerfIndexes")]
    partial class V8PerfIndexes
    {
        protected override void BuildTargetModel(ModelBuilder modelBuilder)
        {
#pragma warning disable 612, 618
            modelBuilder
                .HasAnnotation("ProductVersion", "10.0.0")
                .HasAnnotation("Relational:MaxIdentifierLength", 63);

            NpgsqlModelBuilderExtensions.UseIdentityByDefaultColumns(modelBuilder);

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ApplicationConfig", b =>
                {
                    b.Property<long>("Id")
                        .HasColumnType("bigint");

                    b.Property<bool>("ClearLogs")
                        .HasColumnType("boolean");

                    b.Property<int>("ClearLogsOlderThanDays")
                        .HasColumnType("integer");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<int>("DefaultChunkSize")
                        .HasColumnType("integer");

                    b.Property<string>("DefaultLanguage")
                        .IsRequired()
                        .HasMaxLength(35)
                        .HasColumnType("character varying(35)");

                    b.Property<bool>("DeleteNotCancel")
                        .HasColumnType("boolean");

                    b.Property<bool>("FinishSingleSubtitleFirst")
                        .HasColumnType("boolean");

                    b.Property<int>("LogRetentionDays")
                        .HasColumnType("integer");

                    b.Property<bool>("LogRetentionEnabled")
                        .HasColumnType("boolean");

                    b.Property<int>("MaxRetriesPerChunk")
                        .HasColumnType("integer");

                    b.Property<bool>("NameDetectionActive")
                        .HasColumnType("boolean");

                    b.Property<string>("RootLibraryPath")
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<bool>("ScanLibraryPaths")
                        .HasColumnType("boolean");

                    b.Property<bool>("ScheduleConfigured")
                        .HasColumnType("boolean");

                    b.Property<long?>("SelectedThemeId")
                        .HasColumnType("bigint");

                    b.Property<int>("SessionTimeoutMinutes")
                        .HasColumnType("integer");

                    b.Property<bool>("SetupCompleted")
                        .HasColumnType("boolean");

                    b.Property<bool>("ShowPosters")
                        .HasColumnType("boolean");

                    b.Property<string>("ThaiAssFont")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<bool>("TheMovieDbActive")
                        .HasColumnType("boolean");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<uint>("Version")
                        .IsConcurrencyToken()
                        .ValueGeneratedOnAddOrUpdate()
                        .HasColumnType("xid")
                        .HasColumnName("xmin");

                    b.Property<bool>("WhisperEnabled")
                        .HasColumnType("boolean");

                    b.Property<string>("WhisperModel")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("WhisperModelRootPath")
                        .HasColumnType("text");

                    b.Property<bool>("WhisperRunAsSeparateTask")
                        .HasColumnType("boolean");

                    b.Property<int>("WhisperTimestampsLength")
                        .HasColumnType("integer");

                    b.Property<bool>("WhisperUseCuda")
                        .HasColumnType("boolean");

                    b.HasKey("Id");

                    b.HasIndex("SelectedThemeId");

                    b.ToTable("application_config", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ApplicationLog", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("EntityId")
                        .HasColumnType("bigint");

                    b.Property<string>("EntityType")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("Level")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<string>("Message")
                        .IsRequired()
                        .HasColumnType("text");

                    b.Property<string>("Metadata")
                        .HasColumnType("jsonb");

                    b.Property<string>("Type")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.HasKey("Id");

                    b.HasIndex("CreatedAt");

                    b.HasIndex("Type");

                    b.HasIndex("EntityType", "EntityId");

                    b.ToTable("application_logs", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ApplicationRole", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<string>("ConcurrencyStamp")
                        .IsConcurrencyToken()
                        .HasColumnType("text");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Description")
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<int>("Level")
                        .HasColumnType("integer");

                    b.Property<string>("Name")
                        .HasMaxLength(256)
                        .HasColumnType("character varying(256)");

                    b.Property<string>("NormalizedName")
                        .HasMaxLength(256)
                        .HasColumnType("character varying(256)");

                    b.HasKey("Id");

                    b.HasIndex("Level")
                        .IsUnique();

                    b.HasIndex("NormalizedName")
                        .IsUnique()
                        .HasDatabaseName("RoleNameIndex");

                    b.ToTable("AspNetRoles", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ApplicationSecret", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<string>("Algorithm")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<byte[]>("Ciphertext")
                        .IsRequired()
                        .HasColumnType("bytea");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Key")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<byte[]>("Nonce")
                        .IsRequired()
                        .HasColumnType("bytea");

                    b.Property<bool>("SetByEnv")
                        .HasColumnType("boolean");

                    b.Property<byte[]>("Tag")
                        .IsRequired()
                        .HasColumnType("bytea");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("Key")
                        .IsUnique();

                    b.ToTable("app_secrets", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ApplicationUser", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<int>("AccessFailedCount")
                        .HasColumnType("integer");

                    b.Property<string>("ConcurrencyStamp")
                        .IsConcurrencyToken()
                        .HasColumnType("text");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("DeletedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Email")
                        .HasMaxLength(256)
                        .HasColumnType("character varying(256)");

                    b.Property<bool>("EmailConfirmed")
                        .HasColumnType("boolean");

                    b.Property<bool>("HasSeenTutorial")
                        .HasColumnType("boolean");

                    b.Property<string>("Language")
                        .HasMaxLength(35)
                        .HasColumnType("character varying(35)");

                    b.Property<bool>("LockoutEnabled")
                        .HasColumnType("boolean");

                    b.Property<DateTimeOffset?>("LockoutEnd")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("NormalizedEmail")
                        .HasMaxLength(256)
                        .HasColumnType("character varying(256)");

                    b.Property<string>("NormalizedUserName")
                        .HasMaxLength(256)
                        .HasColumnType("character varying(256)");

                    b.Property<string>("PasswordHash")
                        .HasColumnType("text");

                    b.Property<string>("PhoneNumber")
                        .HasColumnType("text");

                    b.Property<bool>("PhoneNumberConfirmed")
                        .HasColumnType("boolean");

                    b.Property<string>("SecurityStamp")
                        .HasColumnType("text");

                    b.Property<long?>("SelectedThemeId")
                        .HasColumnType("bigint");

                    b.Property<bool>("ShowPosters")
                        .HasColumnType("boolean");

                    b.Property<bool>("TwoFactorEnabled")
                        .HasColumnType("boolean");

                    b.Property<string>("UserName")
                        .HasMaxLength(256)
                        .HasColumnType("character varying(256)");

                    b.HasKey("Id");

                    b.HasIndex("NormalizedEmail")
                        .HasDatabaseName("EmailIndex");

                    b.HasIndex("NormalizedUserName")
                        .IsUnique()
                        .HasDatabaseName("UserNameIndex");

                    b.HasIndex("SelectedThemeId");

                    b.ToTable("AspNetUsers", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ConfigTranslationLanguage", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("LanguageId")
                        .HasColumnType("bigint");

                    b.Property<int>("Position")
                        .HasColumnType("integer");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("LanguageId")
                        .IsUnique();

                    b.ToTable("config_translation_languages", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ExportedSubtitleFile", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<bool>("IsWhisper")
                        .HasColumnType("boolean");

                    b.Property<long>("LibraryPathId")
                        .HasColumnType("bigint");

                    b.Property<string>("Path")
                        .IsRequired()
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<long?>("SubtitleId")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("SubtitleId");

                    b.HasIndex("LibraryPathId", "Path")
                        .IsUnique();

                    b.ToTable("exported_subtitle_files", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.JudgeEvaluation", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("JudgeInput")
                        .HasColumnType("text");

                    b.Property<string>("JudgeReason")
                        .HasColumnType("text");

                    b.Property<long?>("ModelId")
                        .HasColumnType("bigint");

                    b.Property<long?>("SelectedCandidateId")
                        .HasColumnType("bigint");

                    b.Property<long>("SubtitleChunkId")
                        .HasColumnType("bigint");

                    b.HasKey("Id");

                    b.HasIndex("CreatedAt");

                    b.HasIndex("SelectedCandidateId");

                    b.HasIndex("SubtitleChunkId");

                    b.HasIndex("ModelId", "CreatedAt");

                    b.ToTable("judge_evaluations", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Language", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Flag")
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<string>("Iso639")
                        .IsRequired()
                        .HasMaxLength(8)
                        .HasColumnType("character varying(8)");

                    b.Property<string>("Iso6392B")
                        .HasMaxLength(8)
                        .HasColumnType("character varying(8)");

                    b.Property<string>("Locale")
                        .IsRequired()
                        .HasMaxLength(35)
                        .HasColumnType("character varying(35)");

                    b.Property<string>("Name")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("Iso639", "Locale")
                        .IsUnique();

                    b.ToTable("languages", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPath", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<bool>("AutoExtract")
                        .HasColumnType("boolean");

                    b.Property<bool>("AutoTranslate")
                        .HasColumnType("boolean");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<bool>("Enabled")
                        .HasColumnType("boolean");

                    b.Property<bool>("InitialScanCompleted")
                        .HasColumnType("boolean");

                    b.Property<long?>("InitialScanDurationMs")
                        .HasColumnType("bigint");

                    b.Property<DateTime?>("LastRunAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("LastScanDurationMs")
                        .HasColumnType("bigint");

                    b.Property<string>("Name")
                        .IsRequired()
                        .HasMaxLength(200)
                        .HasColumnType("character varying(200)");

                    b.Property<string>("Path")
                        .IsRequired()
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<int>("PostInitialScanCount")
                        .HasColumnType("integer");

                    b.Property<long>("PostInitialScanTotalMs")
                        .HasColumnType("bigint");

                    b.Property<string>("ScanDayOfWeek")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<int>("ScanDurationMinutes")
                        .HasColumnType("integer");

                    b.Property<DateTime?>("ScanFirstStartAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("ScanMode")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<int>("ScanRepeatInterval")
                        .HasColumnType("integer");

                    b.Property<string>("ScanRepeatUnit")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<TimeSpan>("ScanStartTime")
                        .HasColumnType("time");

                    b.Property<long>("SourceLanguageId")
                        .HasColumnType("bigint");

                    b.Property<string>("State")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<string>("Type")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("Name")
                        .IsUnique();

                    b.HasIndex("Path")
                        .IsUnique();

                    b.HasIndex("SourceLanguageId");

                    b.ToTable("library_paths", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPathItem", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<int?>("Episode")
                        .HasColumnType("integer");

                    b.Property<string>("ExtractFileName")
                        .IsRequired()
                        .HasMaxLength(300)
                        .HasColumnType("character varying(300)");

                    b.Property<bool>("IsExtra")
                        .HasColumnType("boolean");

                    b.Property<long>("LibraryPathId")
                        .HasColumnType("bigint");

                    b.Property<long?>("MediaItemId")
                        .HasColumnType("bigint");

                    b.Property<string>("Path")
                        .IsRequired()
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<int?>("Season")
                        .HasColumnType("integer");

                    b.Property<string>("Status")
                        .IsRequired()
                        .HasMaxLength(24)
                        .HasColumnType("character varying(24)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("ExtractFileName");

                    b.HasIndex("MediaItemId");

                    b.HasIndex("LibraryPathId", "Path")
                        .IsUnique();

                    b.HasIndex("LibraryPathId", "Status");

                    b.ToTable("library_path_items", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPathItemBlacklist", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<long?>("BlacklistedByUserId")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("LibraryPathItemId")
                        .HasColumnType("bigint");

                    b.Property<string>("Reason")
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("BlacklistedByUserId");

                    b.HasIndex("LibraryPathItemId")
                        .IsUnique();

                    b.ToTable("library_path_item_blacklist", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPathItemCandidate", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("LibraryPathItemId")
                        .HasColumnType("bigint");

                    b.Property<long>("MediaItemId")
                        .HasColumnType("bigint");

                    b.Property<string>("Path")
                        .IsRequired()
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("MediaItemId");

                    b.HasIndex("LibraryPathItemId", "MediaItemId")
                        .IsUnique();

                    b.ToTable("library_path_item_candidates", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPathItemSubtitleSource", b =>
                {
                    b.Property<long>("LibraryPathItemId")
                        .HasColumnType("bigint");

                    b.Property<long>("FileMtimeMs")
                        .HasColumnType("bigint");

                    b.Property<long>("FileSize")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("ScannedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Sources")
                        .IsRequired()
                        .HasColumnType("jsonb");

                    b.HasKey("LibraryPathItemId");

                    b.ToTable("library_path_item_subtitle_sources", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.MediaItem", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Genres")
                        .IsRequired()
                        .HasColumnType("jsonb");

                    b.Property<bool?>("IsAnime")
                        .HasColumnType("boolean");

                    b.Property<string>("OriginalTitle")
                        .HasMaxLength(300)
                        .HasColumnType("character varying(300)");

                    b.Property<string>("PhotoPath")
                        .HasMaxLength(200)
                        .HasColumnType("character varying(200)");

                    b.Property<string>("TheMovieDbId")
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("Title")
                        .IsRequired()
                        .HasMaxLength(300)
                        .HasColumnType("character varying(300)");

                    b.Property<string>("Type")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<int?>("Year")
                        .HasColumnType("integer");

                    b.HasKey("Id");

                    b.HasIndex("TheMovieDbId");

                    b.HasIndex("Title", "Type", "Year");

                    b.ToTable("media_items", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Model", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<bool>("Active")
                        .HasColumnType("boolean");

                    b.Property<string>("BaseUrl")
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<bool>("CloseAfterUse")
                        .HasColumnType("boolean");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("DeletedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("ModelName")
                        .IsRequired()
                        .HasMaxLength(200)
                        .HasColumnType("character varying(200)");

                    b.Property<string>("ModelUpdatedAt")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("Name")
                        .IsRequired()
                        .HasMaxLength(200)
                        .HasColumnType("character varying(200)");

                    b.Property<string>("ParameterSize")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("Provider")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<long?>("RecommendedModelId")
                        .HasColumnType("bigint");

                    b.Property<string>("Size")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("RecommendedModelId");

                    b.HasIndex("ModelName", "ModelUpdatedAt")
                        .IsUnique();

                    NpgsqlIndexBuilderExtensions.AreNullsDistinct(b.HasIndex("ModelName", "ModelUpdatedAt"), false);

                    b.ToTable("models", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ModelRole", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("DeletedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("ModelId")
                        .HasColumnType("bigint");

                    b.Property<string>("Role")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.HasKey("Id");

                    b.HasIndex("ModelId", "Role")
                        .IsUnique();

                    b.ToTable("model_roles", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Permission", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<string>("Category")
                        .HasMaxLength(50)
                        .HasColumnType("character varying(50)");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Description")
                        .IsRequired()
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<string>("Key")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("Label")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("Key")
                        .IsUnique();

                    b.ToTable("permissions", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Prompt", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<bool>("Active")
                        .HasColumnType("boolean");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Kind")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("Name")
                        .IsRequired()
                        .HasMaxLength(200)
                        .HasColumnType("character varying(200)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("Name")
                        .IsUnique();

                    b.ToTable("prompts", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.PromptStat", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<int>("FailedCount")
                        .HasColumnType("integer");

                    b.Property<long?>("LanguageId")
                        .HasColumnType("bigint");

                    b.Property<long>("ModelId")
                        .HasColumnType("bigint");

                    b.Property<long>("PromptId")
                        .HasColumnType("bigint");

                    b.Property<long>("PromptVersionId")
                        .HasColumnType("bigint");

                    b.Property<int>("RequestCount")
                        .HasColumnType("integer");

                    b.Property<int>("SelectedCount")
                        .HasColumnType("integer");

                    b.Property<int>("SuccessCount")
                        .HasColumnType("integer");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("LanguageId");

                    b.HasIndex("ModelId");

                    b.HasIndex("PromptVersionId");

                    b.HasIndex("PromptId", "PromptVersionId", "ModelId", "LanguageId")
                        .IsUnique();

                    NpgsqlIndexBuilderExtensions.AreNullsDistinct(b.HasIndex("PromptId", "PromptVersionId", "ModelId", "LanguageId"), false);

                    b.ToTable("prompt_stats", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.PromptVersion", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<bool>("Active")
                        .HasColumnType("boolean");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("DeletedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("PromptId")
                        .HasColumnType("bigint");

                    b.Property<string>("PromptText")
                        .IsRequired()
                        .HasColumnType("text");

                    b.Property<int>("Version")
                        .HasColumnType("integer");

                    b.HasKey("Id");

                    b.HasIndex("PromptId", "Version")
                        .IsUnique();

                    b.ToTable("prompt_versions", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.RecommendedModel", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<string>("BaseUrl")
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Name")
                        .IsRequired()
                        .HasMaxLength(200)
                        .HasColumnType("character varying(200)");

                    b.Property<string>("ParameterSize")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("Provider")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<bool>("RequireOllamaSubscription")
                        .HasColumnType("boolean");

                    b.Property<string>("Roles")
                        .IsRequired()
                        .HasColumnType("jsonb");

                    b.Property<string>("Score")
                        .IsRequired()
                        .HasMaxLength(300)
                        .HasColumnType("character varying(300)");

                    b.Property<string>("Size")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("Name")
                        .IsUnique();

                    b.ToTable("recommended_models", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Schedule", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("DayOfTheWeek")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<int>("DurationMinutes")
                        .HasColumnType("integer");

                    b.Property<bool>("Enabled")
                        .HasColumnType("boolean");

                    b.Property<DateTime?>("FirstStartAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("LastRunAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<int>("RepeatInterval")
                        .HasColumnType("integer");

                    b.Property<string>("RepeatUnit")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<TimeSpan>("StartTime")
                        .HasColumnType("time");

                    b.Property<string>("TaskName")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.ToTable("schedules", null, t =>
                        {
                            t.HasCheckConstraint("CK_schedules_duration_positive", "\"DurationMinutes\" > 0");

                            t.HasCheckConstraint("CK_schedules_interval_positive", "\"RepeatInterval\" > 0");
                        });
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Subtitle", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime?>("CancelledAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("CancelledByUserId")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("DeletedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("DeletedByUserId")
                        .HasColumnType("bigint");

                    b.Property<int?>("Episode")
                        .HasColumnType("integer");

                    b.Property<DateTime?>("FinishedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<bool>("Hide")
                        .HasColumnType("boolean");

                    b.Property<long?>("LibraryPathItemId")
                        .HasColumnType("bigint");

                    b.Property<long?>("MediaItemId")
                        .HasColumnType("bigint");

                    b.Property<string>("MediaPath")
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<string>("Name")
                        .IsRequired()
                        .HasMaxLength(300)
                        .HasColumnType("character varying(300)");

                    b.Property<string>("OriginalFileHash")
                        .IsRequired()
                        .HasMaxLength(64)
                        .HasColumnType("character varying(64)");

                    b.Property<string>("OriginalFileName")
                        .IsRequired()
                        .HasMaxLength(300)
                        .HasColumnType("character varying(300)");

                    b.Property<string>("OriginalSourceFormat")
                        .HasMaxLength(8)
                        .HasColumnType("character varying(8)");

                    b.Property<string>("OriginalText")
                        .IsRequired()
                        .HasColumnType("text");

                    b.Property<int>("Priority")
                        .HasColumnType("integer");

                    b.Property<int?>("Season")
                        .HasColumnType("integer");

                    b.Property<string>("Source")
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<string>("SourceFormat")
                        .IsRequired()
                        .HasMaxLength(8)
                        .HasColumnType("character varying(8)");

                    b.Property<long>("SourceLanguageId")
                        .HasColumnType("bigint");

                    b.Property<string>("SourcePath")
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<string>("Status")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<string>("TextOrigin")
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("UserId")
                        .HasColumnType("bigint");

                    b.Property<long>("WhisperDurationMs")
                        .HasColumnType("bigint");

                    b.Property<string>("WhisperModel")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<long>("WhisperPositionMs")
                        .HasColumnType("bigint");

                    b.Property<int?>("WhisperPriority")
                        .HasColumnType("integer");

                    b.Property<int>("WhisperProgress")
                        .HasColumnType("integer");

                    b.Property<long>("WhisperResumeMs")
                        .HasColumnType("bigint");

                    b.Property<string>("WhisperResumeSrt")
                        .HasColumnType("text");

                    b.Property<int?>("WhisperTimestampsLength")
                        .HasColumnType("integer");

                    b.Property<string>("WhisperTranscriptionState")
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<bool?>("WhisperUseCuda")
                        .HasColumnType("boolean");

                    b.HasKey("Id");

                    b.HasIndex("CancelledByUserId");

                    b.HasIndex("DeletedByUserId");

                    b.HasIndex("LibraryPathItemId");

                    b.HasIndex("MediaItemId");

                    b.HasIndex("OriginalFileHash");

                    b.HasIndex("SourceLanguageId");

                    b.HasIndex("UserId");

                    b.HasIndex("WhisperTranscriptionState");

                    b.HasIndex("Status", "Priority");

                    b.ToTable("subtitles", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.SubtitleChunk", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<int>("ChunkIndex")
                        .HasColumnType("integer");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("DurationMs")
                        .HasColumnType("bigint");

                    b.Property<string>("ErrorMessage")
                        .HasColumnType("text");

                    b.Property<DateTime?>("FinishedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("JudgeModelId")
                        .HasColumnType("bigint");

                    b.Property<string>("JudgeReason")
                        .HasColumnType("text");

                    b.Property<int>("RetryCount")
                        .HasColumnType("integer");

                    b.Property<long?>("SelectedCandidateId")
                        .HasColumnType("bigint");

                    b.Property<int>("SrtIdFrom")
                        .HasColumnType("integer");

                    b.Property<int>("SrtIdTo")
                        .HasColumnType("integer");

                    b.Property<DateTime?>("StartedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Status")
                        .IsRequired()
                        .HasMaxLength(24)
                        .HasColumnType("character varying(24)");

                    b.Property<long>("SubtitleId")
                        .HasColumnType("bigint");

                    b.Property<long>("SubtitleJobId")
                        .HasColumnType("bigint");

                    b.Property<long>("TargetLanguageId")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("JudgeModelId");

                    b.HasIndex("SelectedCandidateId");

                    b.HasIndex("SubtitleId");

                    b.HasIndex("TargetLanguageId");

                    b.HasIndex("Status", "StartedAt");

                    b.HasIndex("SubtitleJobId", "ChunkIndex")
                        .IsUnique();

                    b.ToTable("subtitle_chunks", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.SubtitleChunkCandidate", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("DurationMs")
                        .HasColumnType("bigint");

                    b.Property<string>("ErrorMessage")
                        .HasColumnType("text");

                    b.Property<long?>("ModelId")
                        .HasColumnType("bigint");

                    b.Property<long?>("PromptId")
                        .HasColumnType("bigint");

                    b.Property<long?>("PromptVersionId")
                        .HasColumnType("bigint");

                    b.Property<int>("RetryCount")
                        .HasColumnType("integer");

                    b.Property<bool>("Selected")
                        .HasColumnType("boolean");

                    b.Property<string>("Status")
                        .IsRequired()
                        .HasMaxLength(24)
                        .HasColumnType("character varying(24)");

                    b.Property<long>("SubtitleChunkId")
                        .HasColumnType("bigint");

                    b.Property<string>("TranslatedText")
                        .HasColumnType("text");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<bool?>("ValidationPassed")
                        .HasColumnType("boolean");

                    b.HasKey("Id");

                    b.HasIndex("ModelId");

                    b.HasIndex("PromptId");

                    b.HasIndex("PromptVersionId");

                    b.HasIndex("Status", "UpdatedAt");

                    b.HasIndex("SubtitleChunkId", "ModelId", "PromptVersionId")
                        .IsUnique();

                    NpgsqlIndexBuilderExtensions.AreNullsDistinct(b.HasIndex("SubtitleChunkId", "ModelId", "PromptVersionId"), false);

                    b.ToTable("subtitle_chunk_candidates", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.SubtitleJob", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime?>("CancelledAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("CancelledByUserId")
                        .HasColumnType("bigint");

                    b.Property<int>("ChunkSetting")
                        .HasColumnType("integer");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<int>("CurrentChunk")
                        .HasColumnType("integer");

                    b.Property<DateTime?>("DeletedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("DeletedByUserId")
                        .HasColumnType("bigint");

                    b.Property<int?>("Episode")
                        .HasColumnType("integer");

                    b.Property<DateTime?>("FinishedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("OutputFilePath")
                        .HasColumnType("text");

                    b.Property<string>("OutputHash")
                        .HasColumnType("text");

                    b.Property<int>("Priority")
                        .HasColumnType("integer");

                    b.Property<int?>("Season")
                        .HasColumnType("integer");

                    b.Property<string>("Status")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<long>("SubtitleId")
                        .HasColumnType("bigint");

                    b.Property<long>("TargetLanguageId")
                        .HasColumnType("bigint");

                    b.Property<int>("TotalChunks")
                        .HasColumnType("integer");

                    b.Property<string>("TranslatedText")
                        .HasColumnType("text");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("UserId")
                        .HasColumnType("bigint");

                    b.HasKey("Id");

                    b.HasIndex("CancelledByUserId");

                    b.HasIndex("DeletedByUserId");

                    b.HasIndex("TargetLanguageId");

                    b.HasIndex("UserId");

                    b.HasIndex("Status", "Priority");

                    b.HasIndex("SubtitleId", "TargetLanguageId")
                        .IsUnique();

                    b.ToTable("subtitle_jobs", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Theme", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<string>("Accent")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("AccentDim")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("Bg")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("BorderColor")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("CreatedByUserId")
                        .HasColumnType("bigint");

                    b.Property<string>("Error")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("ErrorDim")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("InfoDim")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<bool>("IsPublic")
                        .HasColumnType("boolean");

                    b.Property<string>("Name")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("Success")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("SuccessDim")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("Surface")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("Surface2")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("Surface3")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("TextColor")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("TextDim")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("TextHint")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Warning")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.Property<string>("WarningDim")
                        .IsRequired()
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.HasKey("Id");

                    b.HasIndex("CreatedByUserId");

                    b.HasIndex("Name")
                        .IsUnique();

                    b.ToTable("themes", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.TranslatedLibraryItem", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("DetectedAtPath")
                        .IsRequired()
                        .HasMaxLength(500)
                        .HasColumnType("character varying(500)");

                    b.Property<long?>("FileMtimeMs")
                        .HasColumnType("bigint");

                    b.Property<long>("LanguageId")
                        .HasColumnType("bigint");

                    b.Property<long>("LibraryPathItemId")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("LanguageId");

                    b.HasIndex("LibraryPathItemId", "LanguageId")
                        .IsUnique();

                    b.ToTable("translated_library_items", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.UserConfigTranslationLanguage", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("LanguageId")
                        .HasColumnType("bigint");

                    b.Property<int>("Position")
                        .HasColumnType("integer");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("UserId")
                        .HasColumnType("bigint");

                    b.HasKey("Id");

                    b.HasIndex("LanguageId");

                    b.HasIndex("UserId", "LanguageId")
                        .IsUnique();

                    b.ToTable("user_config_translation_languages", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.WorkerCredential", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("RevokedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("SecretHash")
                        .IsRequired()
                        .HasMaxLength(64)
                        .HasColumnType("character varying(64)");

                    b.Property<long>("WorkerId")
                        .HasColumnType("bigint");

                    b.HasKey("Id");

                    b.HasIndex("SecretHash");

                    b.HasIndex("WorkerId");

                    b.ToTable("worker_credentials", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.WorkerEnrollment", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<string>("CodeHash")
                        .IsRequired()
                        .HasMaxLength(64)
                        .HasColumnType("character varying(64)");

                    b.Property<string>("CodePrefix")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<DateTime?>("ConsumedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("ConsumedByWorkerId")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long>("CreatedByUserId")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("ExpiresAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Label")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<DateTime?>("RevokedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("CodeHash")
                        .IsUnique();

                    b.HasIndex("ConsumedByWorkerId");

                    b.HasIndex("CreatedByUserId");

                    b.ToTable("worker_enrollments", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.WorkerJob", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<DateTime?>("ClaimedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("ClaimedByWorkerId")
                        .HasColumnType("bigint");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<long?>("CreatedByUserId")
                        .HasColumnType("bigint");

                    b.Property<string>("DisplayName")
                        .HasMaxLength(300)
                        .HasColumnType("character varying(300)");

                    b.Property<string>("ErrorCode")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("ErrorMessage")
                        .HasMaxLength(1000)
                        .HasColumnType("character varying(1000)");

                    b.Property<DateTime?>("FinishedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("HeartbeatAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("JobType")
                        .IsRequired()
                        .HasMaxLength(50)
                        .HasColumnType("character varying(50)");

                    b.Property<DateTime?>("LeaseExpiresAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<int>("MaxRetries")
                        .HasColumnType("integer");

                    b.Property<DateTime?>("NextRetryAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Payload")
                        .HasColumnType("jsonb");

                    b.Property<int>("Priority")
                        .HasColumnType("integer");

                    b.Property<int>("Progress")
                        .HasColumnType("integer");

                    b.Property<string>("RequiredCapability")
                        .HasMaxLength(50)
                        .HasColumnType("character varying(50)");

                    b.Property<string>("Result")
                        .HasColumnType("jsonb");

                    b.Property<int>("RetryCount")
                        .HasColumnType("integer");

                    b.Property<DateTime?>("StartedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("Status")
                        .IsRequired()
                        .HasMaxLength(16)
                        .HasColumnType("character varying(16)");

                    b.Property<long?>("SubjectId")
                        .HasColumnType("bigint");

                    b.Property<string>("SubjectType")
                        .HasMaxLength(50)
                        .HasColumnType("character varying(50)");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.HasKey("Id");

                    b.HasIndex("CreatedByUserId");

                    b.HasIndex("ClaimedByWorkerId", "Status");

                    b.HasIndex("SubjectType", "SubjectId");

                    b.HasIndex("JobType", "SubjectType", "SubjectId")
                        .IsUnique()
                        .HasFilter("\"Status\" IN ('Queued', 'Running')");

                    b.HasIndex("Status", "Priority", "CreatedAt");

                    b.ToTable("worker_jobs", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.WorkerNode", b =>
                {
                    b.Property<long>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("bigint");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<long>("Id"));

                    b.Property<string>("AllowedCapabilities")
                        .IsRequired()
                        .HasColumnType("jsonb");

                    b.Property<DateTime>("CreatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<bool>("Draining")
                        .HasColumnType("boolean");

                    b.Property<bool>("Enabled")
                        .HasColumnType("boolean");

                    b.Property<DateTime?>("LastConnectedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("LastDisconnectedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<DateTime?>("LastSeenAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("MachineIdentifier")
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<int>("MaxConcurrency")
                        .HasColumnType("integer");

                    b.Property<string>("Name")
                        .IsRequired()
                        .HasMaxLength(100)
                        .HasColumnType("character varying(100)");

                    b.Property<string>("ReportedCapabilities")
                        .IsRequired()
                        .HasColumnType("jsonb");

                    b.Property<DateTime>("UpdatedAt")
                        .HasColumnType("timestamp with time zone");

                    b.Property<string>("WorkerVersion")
                        .HasMaxLength(32)
                        .HasColumnType("character varying(32)");

                    b.HasKey("Id");

                    b.HasIndex("Name")
                        .IsUnique();

                    b.ToTable("worker_nodes", (string)null);
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityRoleClaim<long>", b =>
                {
                    b.Property<int>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("integer");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<int>("Id"));

                    b.Property<string>("ClaimType")
                        .HasColumnType("text");

                    b.Property<string>("ClaimValue")
                        .HasColumnType("text");

                    b.Property<long>("RoleId")
                        .HasColumnType("bigint");

                    b.HasKey("Id");

                    b.HasIndex("RoleId");

                    b.ToTable("AspNetRoleClaims", (string)null);
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityUserClaim<long>", b =>
                {
                    b.Property<int>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("integer");

                    NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<int>("Id"));

                    b.Property<string>("ClaimType")
                        .HasColumnType("text");

                    b.Property<string>("ClaimValue")
                        .HasColumnType("text");

                    b.Property<long>("UserId")
                        .HasColumnType("bigint");

                    b.HasKey("Id");

                    b.HasIndex("UserId");

                    b.ToTable("AspNetUserClaims", (string)null);
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityUserLogin<long>", b =>
                {
                    b.Property<string>("LoginProvider")
                        .HasColumnType("text");

                    b.Property<string>("ProviderKey")
                        .HasColumnType("text");

                    b.Property<string>("ProviderDisplayName")
                        .HasColumnType("text");

                    b.Property<long>("UserId")
                        .HasColumnType("bigint");

                    b.HasKey("LoginProvider", "ProviderKey");

                    b.HasIndex("UserId");

                    b.ToTable("AspNetUserLogins", (string)null);
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityUserRole<long>", b =>
                {
                    b.Property<long>("UserId")
                        .HasColumnType("bigint");

                    b.Property<long>("RoleId")
                        .HasColumnType("bigint");

                    b.HasKey("UserId", "RoleId");

                    b.HasIndex("RoleId");

                    b.ToTable("AspNetUserRoles", (string)null);
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityUserToken<long>", b =>
                {
                    b.Property<long>("UserId")
                        .HasColumnType("bigint");

                    b.Property<string>("LoginProvider")
                        .HasColumnType("text");

                    b.Property<string>("Name")
                        .HasColumnType("text");

                    b.Property<string>("Value")
                        .HasColumnType("text");

                    b.HasKey("UserId", "LoginProvider", "Name");

                    b.ToTable("AspNetUserTokens", (string)null);
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ApplicationConfig", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Theme", "SelectedTheme")
                        .WithMany()
                        .HasForeignKey("SelectedThemeId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.Navigation("SelectedTheme");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ApplicationUser", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Theme", "SelectedTheme")
                        .WithMany()
                        .HasForeignKey("SelectedThemeId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.Navigation("SelectedTheme");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ConfigTranslationLanguage", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Language", "Language")
                        .WithMany()
                        .HasForeignKey("LanguageId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Language");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ExportedSubtitleFile", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.LibraryPath", "LibraryPath")
                        .WithMany()
                        .HasForeignKey("LibraryPathId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Subtitle", "Subtitle")
                        .WithMany()
                        .HasForeignKey("SubtitleId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.Navigation("LibraryPath");

                    b.Navigation("Subtitle");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.JudgeEvaluation", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Model", "Model")
                        .WithMany()
                        .HasForeignKey("ModelId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.SubtitleChunkCandidate", "SelectedCandidate")
                        .WithMany()
                        .HasForeignKey("SelectedCandidateId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.SubtitleChunk", "SubtitleChunk")
                        .WithMany()
                        .HasForeignKey("SubtitleChunkId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Model");

                    b.Navigation("SelectedCandidate");

                    b.Navigation("SubtitleChunk");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPath", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Language", "SourceLanguage")
                        .WithMany()
                        .HasForeignKey("SourceLanguageId")
                        .OnDelete(DeleteBehavior.Restrict)
                        .IsRequired();

                    b.Navigation("SourceLanguage");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPathItem", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.LibraryPath", "LibraryPath")
                        .WithMany()
                        .HasForeignKey("LibraryPathId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.MediaItem", "MediaItem")
                        .WithMany()
                        .HasForeignKey("MediaItemId")
                        .OnDelete(DeleteBehavior.Cascade);

                    b.Navigation("LibraryPath");

                    b.Navigation("MediaItem");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPathItemBlacklist", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "BlacklistedByUser")
                        .WithMany()
                        .HasForeignKey("BlacklistedByUserId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.LibraryPathItem", "LibraryPathItem")
                        .WithMany()
                        .HasForeignKey("LibraryPathItemId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("BlacklistedByUser");

                    b.Navigation("LibraryPathItem");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPathItemCandidate", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.LibraryPathItem", "LibraryPathItem")
                        .WithMany()
                        .HasForeignKey("LibraryPathItemId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.MediaItem", "MediaItem")
                        .WithMany()
                        .HasForeignKey("MediaItemId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("LibraryPathItem");

                    b.Navigation("MediaItem");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.LibraryPathItemSubtitleSource", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.LibraryPathItem", "LibraryPathItem")
                        .WithOne()
                        .HasForeignKey("BCookieSubs.Shared.Database.Entities.LibraryPathItemSubtitleSource", "LibraryPathItemId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("LibraryPathItem");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Model", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.RecommendedModel", "RecommendedModel")
                        .WithMany()
                        .HasForeignKey("RecommendedModelId")
                        .OnDelete(DeleteBehavior.Restrict);

                    b.Navigation("RecommendedModel");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.ModelRole", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Model", "Model")
                        .WithMany("ModelRoles")
                        .HasForeignKey("ModelId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Model");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.PromptStat", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Language", "Language")
                        .WithMany()
                        .HasForeignKey("LanguageId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Model", "Model")
                        .WithMany()
                        .HasForeignKey("ModelId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Prompt", "Prompt")
                        .WithMany()
                        .HasForeignKey("PromptId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.PromptVersion", "PromptVersion")
                        .WithMany()
                        .HasForeignKey("PromptVersionId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Language");

                    b.Navigation("Model");

                    b.Navigation("Prompt");

                    b.Navigation("PromptVersion");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.PromptVersion", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Prompt", "Prompt")
                        .WithMany()
                        .HasForeignKey("PromptId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Prompt");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Subtitle", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "CancelledByUser")
                        .WithMany()
                        .HasForeignKey("CancelledByUserId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "DeletedByUser")
                        .WithMany()
                        .HasForeignKey("DeletedByUserId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.LibraryPathItem", "LibraryPathItem")
                        .WithMany()
                        .HasForeignKey("LibraryPathItemId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.MediaItem", "MediaItem")
                        .WithMany()
                        .HasForeignKey("MediaItemId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Language", "SourceLanguage")
                        .WithMany()
                        .HasForeignKey("SourceLanguageId")
                        .OnDelete(DeleteBehavior.Restrict)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "User")
                        .WithMany()
                        .HasForeignKey("UserId")
                        .OnDelete(DeleteBehavior.Restrict)
                        .IsRequired();

                    b.Navigation("CancelledByUser");

                    b.Navigation("DeletedByUser");

                    b.Navigation("LibraryPathItem");

                    b.Navigation("MediaItem");

                    b.Navigation("SourceLanguage");

                    b.Navigation("User");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.SubtitleChunk", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Model", "JudgeModel")
                        .WithMany()
                        .HasForeignKey("JudgeModelId")
                        .OnDelete(DeleteBehavior.Restrict);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.SubtitleChunkCandidate", "SelectedCandidate")
                        .WithMany()
                        .HasForeignKey("SelectedCandidateId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Subtitle", "Subtitle")
                        .WithMany()
                        .HasForeignKey("SubtitleId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.SubtitleJob", "SubtitleJob")
                        .WithMany()
                        .HasForeignKey("SubtitleJobId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Language", "TargetLanguage")
                        .WithMany()
                        .HasForeignKey("TargetLanguageId")
                        .OnDelete(DeleteBehavior.Restrict)
                        .IsRequired();

                    b.Navigation("JudgeModel");

                    b.Navigation("SelectedCandidate");

                    b.Navigation("Subtitle");

                    b.Navigation("SubtitleJob");

                    b.Navigation("TargetLanguage");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.SubtitleChunkCandidate", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Model", "Model")
                        .WithMany()
                        .HasForeignKey("ModelId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Prompt", "Prompt")
                        .WithMany()
                        .HasForeignKey("PromptId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.PromptVersion", "PromptVersion")
                        .WithMany()
                        .HasForeignKey("PromptVersionId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.SubtitleChunk", "SubtitleChunk")
                        .WithMany()
                        .HasForeignKey("SubtitleChunkId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Model");

                    b.Navigation("Prompt");

                    b.Navigation("PromptVersion");

                    b.Navigation("SubtitleChunk");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.SubtitleJob", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "CancelledByUser")
                        .WithMany()
                        .HasForeignKey("CancelledByUserId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "DeletedByUser")
                        .WithMany()
                        .HasForeignKey("DeletedByUserId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Subtitle", "Subtitle")
                        .WithMany()
                        .HasForeignKey("SubtitleId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.Language", "TargetLanguage")
                        .WithMany()
                        .HasForeignKey("TargetLanguageId")
                        .OnDelete(DeleteBehavior.Restrict)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "User")
                        .WithMany()
                        .HasForeignKey("UserId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("CancelledByUser");

                    b.Navigation("DeletedByUser");

                    b.Navigation("Subtitle");

                    b.Navigation("TargetLanguage");

                    b.Navigation("User");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Theme", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "CreatedByUser")
                        .WithMany()
                        .HasForeignKey("CreatedByUserId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.Navigation("CreatedByUser");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.TranslatedLibraryItem", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Language", "Language")
                        .WithMany()
                        .HasForeignKey("LanguageId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.LibraryPathItem", "LibraryPathItem")
                        .WithMany()
                        .HasForeignKey("LibraryPathItemId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Language");

                    b.Navigation("LibraryPathItem");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.UserConfigTranslationLanguage", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.Language", "Language")
                        .WithMany()
                        .HasForeignKey("LanguageId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "User")
                        .WithMany()
                        .HasForeignKey("UserId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Language");

                    b.Navigation("User");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.WorkerCredential", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.WorkerNode", "Worker")
                        .WithMany()
                        .HasForeignKey("WorkerId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.Navigation("Worker");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.WorkerEnrollment", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.WorkerNode", "ConsumedByWorker")
                        .WithMany()
                        .HasForeignKey("ConsumedByWorkerId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", null)
                        .WithMany()
                        .HasForeignKey("CreatedByUserId")
                        .OnDelete(DeleteBehavior.Restrict)
                        .IsRequired();

                    b.Navigation("ConsumedByWorker");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.WorkerJob", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.WorkerNode", "ClaimedByWorker")
                        .WithMany()
                        .HasForeignKey("ClaimedByWorkerId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", "CreatedByUser")
                        .WithMany()
                        .HasForeignKey("CreatedByUserId")
                        .OnDelete(DeleteBehavior.SetNull);

                    b.Navigation("ClaimedByWorker");

                    b.Navigation("CreatedByUser");
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.WorkerNode", b =>
                {
                    b.OwnsOne("BCookieSubs.Shared.Database.Entities.WorkerHardwareInformation", "Hardware", b1 =>
                        {
                            b1.Property<long>("WorkerNodeId");

                            b1.Property<string>("Architecture")
                                .HasMaxLength(32);

                            b1.Property<int>("CpuCores");

                            b1.Property<string>("CpuModel")
                                .HasMaxLength(200);

                            b1.Property<bool>("CudaAvailable");

                            b1.Property<string>("GpuModel")
                                .HasMaxLength(120);

                            b1.Property<string>("GpuVendor")
                                .HasMaxLength(60);

                            b1.Property<long?>("GpuVramBytes");

                            b1.Property<string>("OperatingSystem")
                                .HasMaxLength(100);

                            b1.Property<string>("PythonVersion")
                                .HasMaxLength(32);

                            b1.Property<long>("RamBytes");

                            b1.HasKey("WorkerNodeId");

                            b1.ToTable("worker_nodes");

                            b1.ToJson("Hardware");

                            b1.WithOwner()
                                .HasForeignKey("WorkerNodeId");
                        });

                    b.Navigation("Hardware");
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityRoleClaim<long>", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationRole", null)
                        .WithMany()
                        .HasForeignKey("RoleId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityUserClaim<long>", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", null)
                        .WithMany()
                        .HasForeignKey("UserId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityUserLogin<long>", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", null)
                        .WithMany()
                        .HasForeignKey("UserId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityUserRole<long>", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationRole", null)
                        .WithMany()
                        .HasForeignKey("RoleId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();

                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", null)
                        .WithMany()
                        .HasForeignKey("UserId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();
                });

            modelBuilder.Entity("Microsoft.AspNetCore.Identity.IdentityUserToken<long>", b =>
                {
                    b.HasOne("BCookieSubs.Shared.Database.Entities.ApplicationUser", null)
                        .WithMany()
                        .HasForeignKey("UserId")
                        .OnDelete(DeleteBehavior.Cascade)
                        .IsRequired();
                });

            modelBuilder.Entity("BCookieSubs.Shared.Database.Entities.Model", b =>
                {
                    b.Navigation("ModelRoles");
                });
#pragma warning restore 612, 618
        }
    }
}
