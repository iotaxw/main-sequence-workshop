using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Versions;
using MainSequence.Importer;
using Newtonsoft.Json;
using Serilog;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Warning()
    .WriteTo.Console()
    .CreateLogger();

if (args.Length == 0)
{
    PrintUsage();
    return 2;
}

var command = args[0];
if (command == "import" && args.Length == 5)
{
    using var provider = CreateProvider(args[1], args[2], false);
    provider.Initialize();
    provider.Mount();
    provider.PostMount();
    GameDatasetImporter.Import(provider, args[3], args[4]);
    return 0;
}

if (command == "scan" && args.Length is 3 or 4)
{
    using var provider = CreateProvider(args[1], args[2], false);
    provider.Initialize();
    provider.Mount();
    provider.PostMount();
    var filter = args.ElementAtOrDefault(3);
    var paths = provider.Files.Keys
        .Where(path => filter is null || path.Contains(filter, StringComparison.OrdinalIgnoreCase))
        .Order(StringComparer.Ordinal);
    foreach (var path in paths)
    {
        Console.WriteLine(path);
    }
    return 0;
}

if (command == "inspect" && args.Length is 4 or 5)
{
    using var provider = CreateProvider(args[1], args[2], true);
    provider.Initialize();
    provider.Mount();
    provider.PostMount();
    if (args.Length == 5)
    {
        provider.ChangeCulture(args[4]);
    }
    var package = provider.LoadPackage(args[3]);
    Console.WriteLine(JsonConvert.SerializeObject(package.GetExports(), Formatting.Indented));
    return 0;
}

PrintUsage();
return 2;

static DefaultFileProvider CreateProvider(string gameDirectory, string mappingsPath, bool readScriptData)
{
    if (!Directory.Exists(gameDirectory))
    {
        throw new DirectoryNotFoundException($"Game directory not found: {gameDirectory}");
    }
    if (!File.Exists(mappingsPath))
    {
        throw new FileNotFoundException($"Mappings file not found: {mappingsPath}");
    }

    var provider = new DefaultFileProvider(
        gameDirectory,
        SearchOption.TopDirectoryOnly,
        new VersionContainer(EGame.GAME_UE5_7),
        StringComparer.OrdinalIgnoreCase);
    provider.MappingsContainer = new FileUsmapTypeMappingsProvider(mappingsPath);
    provider.ReadScriptData = readScriptData;
    return provider;
}

static void PrintUsage()
{
    Console.Error.WriteLine("Usage:");
    Console.Error.WriteLine("  importer import <game-paks-directory> <mappings.usmap> <build-id> <output.json>");
    Console.Error.WriteLine("  importer scan <game-paks-directory> <mappings.usmap> [path-filter]");
    Console.Error.WriteLine("  importer inspect <game-paks-directory> <mappings.usmap> <asset-path>");
}
