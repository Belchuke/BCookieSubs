# BCookieSubs Development Instructions

## General Architecture

BCookieSubs is a self-hosted subtitle translation app.

Keep the C# solution simple — the structure below is the source of truth, and new
functionality should follow it rather than inventing parallel structures.

---

## C# Solution Structure

Keep the C# solution simple.

Use these projects:

src/
BCookieSubs.Shared/
BCookieSubs.Web/
BCookieSubs.Worker/

Do not create additional Clean Architecture projects such as:

- Domain
- Application
- Infrastructure
- Contracts
- Persistence

unless explicitly requested.

Dependencies:

BCookieSubs.Web
-> BCookieSubs.Shared

BCookieSubs.Worker
-> BCookieSubs.Shared

BCookieSubs.Shared must never reference Web or Worker.

---

## C# Technology Preferences

Prefer the standard Microsoft ecosystem.

Use:

Microsoft.EntityFrameworkCore
Microsoft.AspNetCore.Identity
Microsoft.AspNetCore.Identity.EntityFrameworkCore
Microsoft.Extensions.DependencyInjection
Microsoft.Extensions.DependencyInjection.Extensions
System.Security.Claims
System.IdentityModel.Tokens.Jwt
Microsoft.IdentityModel.Tokens
Microsoft.EntityFrameworkCore.ChangeTracking
Npgsql.EntityFrameworkCore.PostgreSQL

Use PostgreSQL as the database.

Use EF Core as the default ORM.

Raw SQL through EF Core/Npgsql is acceptable when there is a real reason, especially for:

- PostgreSQL concurrency behavior
- SKIP LOCKED
- performance-sensitive queries

Do not introduce another ORM as the primary persistence layer.

Do not introduce:

- NHibernate
- ServiceStack
- third-party dependency injection containers
- MediatR everywhere
- CQRS frameworks
- unnecessary event buses

---

## Repository / Service Structure

Use:

Controller / Background Worker
↓
Service
↓
Repository
↓
EF Core
↓
PostgreSQL

Repositories are only responsible for database access.

Repositories may:

- query the database
- insert/update/delete
- use EF Core
- use projections
- use transactions
- use optimized SQL where appropriate

Repositories must NOT:

- contain business logic
- decide workflow
- call external services
- call gRPC workers
- call Ollama
- call FFmpeg
- decide permissions
- decide retries

Services contain application/business logic.

Services may:

- use multiple repositories
- perform validation
- perform state transitions
- orchestrate workflows
- call external systems
- make retry decisions
- select workers
- enforce permissions

Controllers and BackgroundService classes should remain thin.

---

## Interfaces

Do not create an interface for every class.

Avoid unnecessary pairs such as:

IUserService / UserService
IWorkerRepository / WorkerRepository

when there is only one implementation.

Use interfaces when multiple implementations are useful.

Good examples:

ILlmProvider
ITranscriptionEngine
IOcrEngine
IExternalWorkerClient

---

## ASP.NET Core Identity

Use ASP.NET Core Identity for users and authentication.

Use custom Identity entities where useful:

ApplicationUser : IdentityUser<long>
ApplicationRole : IdentityRole<long>

BCookieSubsDbContext should inherit from IdentityDbContext.

Use Identity cookie authentication for the normal browser UI.

Use ClaimsPrincipal and policies/claims for permissions.

JWT should primarily be used for:

- Python worker authentication
- external API authentication
- future integrations

Do not use JWT unnecessarily for normal browser page navigation.

---

## PostgreSQL

BCookieSubs uses PostgreSQL as its only database engine. Do not use SQLite.

Use native PostgreSQL types where appropriate.

Examples:

INTEGER boolean fields
→ BOOLEAN

structured JSON
→ JSONB when appropriate

Use EF Core migrations.

Do not use EnsureCreated for production schema management.

---

## Python Worker Architecture

Python exists only for specialized compute tasks.

Examples:

- faster-whisper
- advanced OCR
- vision
- future ML workloads

Python workers must NEVER directly access PostgreSQL.

Python workers must NEVER own BCookieSubs business state.

C# is always the source of truth for:

- jobs
- statuses
- retries
- permissions
- ownership
- database relationships
- cancellation
- results

Python communicates with C# through gRPC.

---

## Worker Communication

Remote Python workers connect outbound to the main BCookieSubs server.

Prefer persistent bidirectional gRPC streams.

Do not require inbound ports on worker machines.

Worker availability must depend on:

- enabled state
- live connection
- recent heartbeat
- required capability
- allowed capability
- readiness
- available concurrency

Never assign work purely based on a recent LastSeenAt timestamp.

---

## Worker Scaling

The architecture should support:

PostgreSQL ×1
Web ×N
C# Worker ×N
Python Worker ×N

Python workers may have different capabilities.

Examples:

whisper
ocr
vision

Reported capabilities and allowed capabilities are different concepts.

The administrator controls which reported capabilities BCookieSubs is allowed to use.

---

## Docker

Use Docker Compose.

Do not introduce Kubernetes unless explicitly requested.

Base deployment should support:

PostgreSQL
BCookieSubs.Web
BCookieSubs.Worker
Python Worker

Use a generic Python worker image where possible.

Do not create separate Whisper/OCR/Vision images unless dependencies later require it.

Keep GPU configuration in a separate Compose overlay.

CPU-only installation must remain supported.

---

## Media Files

Do not transfer large media files over gRPC.

Workers should receive:

- media path
- track ID
- timestamps
- configuration

Shared paths should use consistent mounts such as:

/media
/work
/models

---

## Dependency Injection

Use the built-in Microsoft DI system.

Keep Program.cs clean through extension methods such as:

AddBCookieSubsDatabase()
AddBCookieSubsIdentity()
AddBCookieSubsRepositories()
AddBCookieSubsServices()
AddBCookieSubsGrpc()

Use TryAddScoped/TryAddSingleton/etc. where appropriate.

---

## Code Comment Style

Keep source-code comments short and useful.

Small comments are welcome where they explain something non-obvious.

Good:

// Retry transient gRPC failures only.

// Worker streams are runtime state only.

// Keep this transaction short.

// Use SKIP LOCKED to avoid competing workers.

Do NOT write paragraph-length comments in source code.

Do NOT add long explanation blocks above classes or methods.

Do NOT explain obvious code.

Bad:

// Set the worker name.
worker.Name = name;

If an explanation requires a paragraph, put it in:

docs/
README.md

not inside source files.

Avoid unnecessary XML documentation comments.

Prefer clear naming over explanatory comments.

---

## Documentation

Long architectural explanations belong in:

docs/architecture.md
docs/workers.md
README.md

Keep implementation code concise.

---

## Tests

Do not add unit tests unless explicitly requested.

Manual testing is the default development workflow for this project.

Always validate builds and startup where possible.

---

## Build Expectations

After changes, run appropriate validation such as:

dotnet restore
dotnet build

Validate Python startup/imports when Python code changes.

Validate Docker Compose configuration when Docker files change.

Do not claim something was runtime-tested if the environment prevented it.

---

## General Development Philosophy

Keep BCookieSubs pragmatic.

Prefer simple, understandable architecture over architectural ceremony.

Avoid unnecessary:

- abstractions
- interfaces
- projects
- microservices
- queues
- frameworks

Use complexity only where it solves a real problem.
