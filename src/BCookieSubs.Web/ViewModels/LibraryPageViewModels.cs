using BCookieSubs.Shared.Database.Entities;

namespace BCookieSubs.Web.ViewModels;

public record LibraryPathsPageVm(
    List<Language> Languages,
    string? RootLibraryPath,
    bool ShowPosters,
    string? Toast,
    string? Msg);

public record LibraryRequestsPageVm(
    List<Language> Languages,
    bool ShowPosters,
    string? Toast,
    string? Msg,
    List<long> UserTargetLangIds);