FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY BCookieSubs.sln ./
COPY proto/ ./proto/
COPY src/BCookieSubs.Shared/ ./src/BCookieSubs.Shared/
COPY src/BCookieSubs.Worker/ ./src/BCookieSubs.Worker/
RUN dotnet restore src/BCookieSubs.Worker/BCookieSubs.Worker.csproj
RUN dotnet publish src/BCookieSubs.Worker/BCookieSubs.Worker.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish .
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ffmpeg mkvtoolnix \
    && rm -rf /var/lib/apt/lists/*
EXPOSE 5100
ENTRYPOINT ["dotnet", "BCookieSubs.Worker.dll"]