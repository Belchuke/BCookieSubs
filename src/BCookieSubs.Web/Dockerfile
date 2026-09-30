FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY BCookieSubs.sln ./
COPY proto/ ./proto/
COPY src/BCookieSubs.Shared/ ./src/BCookieSubs.Shared/
COPY src/BCookieSubs.Web/ ./src/BCookieSubs.Web/
RUN dotnet restore src/BCookieSubs.Web/BCookieSubs.Web.csproj
RUN dotnet publish src/BCookieSubs.Web/BCookieSubs.Web.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish .
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "BCookieSubs.Web.dll"]