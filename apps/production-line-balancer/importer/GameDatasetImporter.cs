using System.Globalization;
using CUE4Parse.FileProvider;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace MainSequence.Importer;

public static class GameDatasetImporter
{
    private static JArray LoadItemRegistry(DefaultFileProvider provider)
    {
        var registry = LoadExport(provider, "MainSequence/Content/Data/DAT_ItemRegistry.uasset", "ItemRegistry");
        return registry["ItemCategories"] as JArray
            ?? throw new InvalidDataException("Item categories are missing from DAT_ItemRegistry.");
    }

    public static void Import(DefaultFileProvider provider, string buildId, string outputPath, string? iconDirectory = null)
    {
        if (!long.TryParse(buildId, NumberStyles.None, CultureInfo.InvariantCulture, out var parsedBuildId) || parsedBuildId <= 0)
        {
            throw new ArgumentException("Build ID must be a positive integer.", nameof(buildId));
        }
        iconDirectory ??= Path.Combine(".tools", "icons");
        var itemCategories = LoadItemRegistry(provider);
        var rawCategory = itemCategories
            .SingleOrDefault(candidate => Text(candidate["DisplayName"]!) == "Raw Resources")
            ?? throw new InvalidDataException("Raw Resources category is missing from DAT_ItemRegistry.");
        var rawItemIds = rawCategory["Items"]!
            .Select(ReferenceId)
            .Where(id => id != "ITEM_AnyItemFilter")
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (rawItemIds.Length == 0)
        {
            throw new InvalidDataException("Raw Resources category contains no usable items.");
        }
        var nativeItemIds = itemCategories
            .SelectMany(category => category["Items"]!)
            .Select(ReferenceId)
            .Where(id => id != "ITEM_AnyItemFilter")
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        var nativeOrders = nativeItemIds.Select((id, order) => (id, order))
            .ToDictionary(pair => pair.id, pair => pair.order, StringComparer.Ordinal);

        var recipePaths = provider.Files.Keys
            .Where(path => path.StartsWith("MainSequence/Content/Data/Recipes/", StringComparison.Ordinal)
                && path.EndsWith(".uasset", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (recipePaths.Length == 0)
        {
            throw new InvalidDataException("No production recipes were found.");
        }

        var allRecipeExports = recipePaths.Select(path => LoadExport(provider, path, "Recipe")).ToArray();
        var machineOutputs = provider.Files.Keys
            .Where(path => path.StartsWith("MainSequence/Content/Data/Items/MachineItems/", StringComparison.Ordinal)
                && path.EndsWith(".uasset", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .Select(path => LoadExport(provider, path, "Item"))
            .Where(item => item["Recipe"] is JObject)
            .ToLookup(
                item => ReferenceId(item["Recipe"]!),
                item => item["AssetName"]!.Value<string>()!,
                StringComparer.Ordinal);

        string OutputItemId(JObject recipe)
        {
            if (recipe["Output"]?["Item"] is JObject outputItem)
            {
                return ReferenceId(outputItem);
            }
            var matches = machineOutputs[recipe["AssetName"]!.Value<string>()!].ToArray();
            return matches.Length == 1
                ? matches[0]
                : throw new InvalidDataException($"Recipe output is not uniquely identified: {recipe["SourceAsset"]}.");
        }

        static string InputItemId(JObject recipe, JToken input)
        {
            return input["Item"] is JObject item
                ? ReferenceId(item)
                : throw new InvalidDataException($"Recipe has an empty or wildcard input item: {recipe["SourceAsset"]}.");
        }

        JArray Outputs(JObject recipe)
        {
            var outputs = new JArray
            {
                new JObject
                {
                    ["itemId"] = OutputItemId(recipe),
                    ["quantity"] = recipe["Output"]!["Amount"]!.Value<long>().ToString(CultureInfo.InvariantCulture),
                    ["isByproduct"] = false,
                },
            };
            if (recipe["ExtraOutputs"] is JArray extraOutputs)
            {
                foreach (var output in extraOutputs)
                {
                    if (output["Item"] is not JObject item)
                    {
                        throw new InvalidDataException($"Recipe has an invalid extra output: {recipe["SourceAsset"]}.");
                    }
                    outputs.Add(new JObject
                    {
                        ["itemId"] = ReferenceId(item),
                        ["quantity"] = output["Amount"]!.Value<long>().ToString(CultureInfo.InvariantCulture),
                        ["isByproduct"] = true,
                    });
                }
            }
            return outputs;
        }

        string? UnsupportedReason(JObject recipe)
        {
            if (recipe.Property("Inputs") is null)
            {
                return "missing-inputs-field";
            }
            if (Inputs(recipe).Any(input => input["Item"] is not JObject))
            {
                return "wildcard-or-empty-input";
            }
            if (recipe["Output"]?["Item"] is not JObject
                && machineOutputs[recipe["AssetName"]!.Value<string>()!].Count() != 1)
            {
                return "unidentified-output";
            }
            return null;
        }

        var unsupportedRecipes = allRecipeExports
            .Where(recipe => UnsupportedReason(recipe) is not null)
            .Select(recipe => new JObject
            {
                ["id"] = recipe["AssetName"]!.Value<string>(),
                ["sourceAsset"] = recipe["SourceAsset"]!.Value<string>(),
                ["reason"] = UnsupportedReason(recipe),
            })
            .ToArray();
        var recipeExports = allRecipeExports.Where(recipe => UnsupportedReason(recipe) is null).ToArray();
        if (recipeExports.Length == 0)
        {
            throw new InvalidDataException("No concrete production recipes were found.");
        }

        var referencedItemIds = recipeExports
            .SelectMany(recipe => Inputs(recipe)
                .Select(input => InputItemId(recipe, input))
                .Concat(Outputs(recipe).Select(output => output["itemId"]!.Value<string>()!)))
            .Concat(rawItemIds)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var itemPaths = referencedItemIds.ToDictionary(
            id => id,
            id => FindItemPath(provider, id),
            StringComparer.Ordinal);
        var itemExports = referencedItemIds.ToDictionary(
            id => id,
            id => LoadExport(provider, itemPaths[id], "Item"),
            StringComparer.Ordinal);
        var crafterIds = recipeExports
            .Select(recipe => ReferenceId(recipe["Crafter"]!))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var crafterExports = crafterIds.ToDictionary(
            id => id,
            id => LoadExport(provider, $"MainSequence/Content/Data/Crafters/{id}.uasset", "Crafter"),
            StringComparer.Ordinal);
        var buildablePaths = crafterIds.ToDictionary(
            id => id,
            id => FindBuildablePath(provider, id),
            StringComparer.Ordinal);
        var buildableExports = new Dictionary<string, JObject>(StringComparer.Ordinal);
        var allBuildablePaths = provider.Files.Keys
            .Where(path => path.StartsWith("MainSequence/Content/Data/Buildables/", StringComparison.Ordinal)
                && Path.GetFileName(path).StartsWith("DAT_", StringComparison.Ordinal)
                && path.EndsWith(".uasset", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray();
        foreach (var id in crafterIds)
        {
            if (provider.Files.ContainsKey(buildablePaths[id]))
            {
                buildableExports[id] = LoadExport(provider, buildablePaths[id], "Buildable");
                continue;
            }
            var displayName = Text(crafterExports[id]["DisplayName"]!);
            var matches = allBuildablePaths.Where(path =>
                Text(LoadExport(provider, path, "Buildable")["DisplayName"]!) == displayName).ToArray();
            if (matches.Length > 1)
            {
                throw new InvalidDataException($"Multiple buildables match crafter {id}: {displayName}.");
            }
            if (matches.Length == 1)
            {
                buildableExports[id] = LoadExport(provider, matches[0], "Buildable");
            }
        }

        var englishItemNames = referencedItemIds.ToDictionary(
            id => id,
            id => ItemName(provider, id, itemExports[id], buildableExports),
            StringComparer.Ordinal);
        var englishMachineNames = crafterIds.ToDictionary(
            id => id,
            id => Text(buildableExports.TryGetValue(id, out var buildable)
                ? buildable["DisplayName"]!
                : crafterExports[id]["DisplayName"]!),
            StringComparer.Ordinal);
        provider.ChangeCulture("zh-Hans");
        var chineseItemExports = referencedItemIds.ToDictionary(
            id => id,
            id => LoadExport(provider, itemPaths[id], "Item"),
            StringComparer.Ordinal);
        var chineseCrafterExports = crafterIds.ToDictionary(
            id => id,
            id => LoadExport(provider, $"MainSequence/Content/Data/Crafters/{id}.uasset", "Crafter"),
            StringComparer.Ordinal);
        var chineseBuildableExports = buildableExports.ToDictionary(
            pair => pair.Key,
            pair => LoadExport(provider, VfsPath(pair.Value["SourceAsset"]!.Value<string>()!), "Buildable"),
            StringComparer.Ordinal);

        foreach (var id in referencedItemIds)
        {
            IconExporter.Export(provider, itemExports[id]["Icon"]!, Path.Combine(iconDirectory, $"{id}.png"));
        }
        var items = referencedItemIds
            .OrderBy(id => nativeOrders.TryGetValue(id, out var order) ? order : int.MaxValue)
            .ThenBy(id => id, StringComparer.Ordinal)
            .Select(id => new JObject
            {
                ["id"] = id,
                ["name"] = englishItemNames[id],
                ["localizedNames"] = new JObject
                {
                    ["en"] = englishItemNames[id],
                    ["zh-Hans"] = ItemName(provider, id, chineseItemExports[id], chineseBuildableExports),
                },
                ["category"] = rawItemIds.Contains(id, StringComparer.Ordinal)
                    ? "raw"
                    : itemPaths[id].Contains("/MachineItems/", StringComparison.Ordinal) ? "machine" : "item",
                ["nativeOrder"] = nativeOrders.TryGetValue(id, out var nativeOrder)
                    ? JToken.FromObject(nativeOrder)
                    : JValue.CreateNull(),
                ["sourceAsset"] = itemExports[id]["SourceAsset"]!.Value<string>(),
                ["iconAsset"] = itemExports[id]["Icon"]!["ObjectPath"]!.Value<string>(),
            }).ToArray();
        AssignShortCodes(items);

        var machines = crafterIds.Select(id =>
        {
            var hasBuildable = buildableExports.TryGetValue(id, out var buildable);
            var source = hasBuildable ? buildable! : crafterExports[id];
            if (source["Icon"] is not JObject)
            {
                throw new InvalidDataException($"Machine has no icon asset: {id}.");
            }
            IconExporter.Export(provider, source["Icon"]!, Path.Combine(iconDirectory, $"{id}.png"));
            var chineseSource = hasBuildable ? chineseBuildableExports[id] : chineseCrafterExports[id];
            return new JObject
            {
                ["id"] = id,
                ["name"] = englishMachineNames[id],
                ["localizedNames"] = new JObject
                {
                    ["en"] = englishMachineNames[id],
                    ["zh-Hans"] = Text(chineseSource["DisplayName"]!),
                },
                ["powerKW"] = hasBuildable ? PowerKilowatts(source) : null,
                ["sourceAsset"] = source["SourceAsset"]!.Value<string>(),
                ["iconAsset"] = source["Icon"]!["ObjectPath"]!.Value<string>(),
            };
        }).ToArray();
        AssignShortCodes(machines);

        var recipes = recipeExports.Select(recipe => new JObject
        {
            ["id"] = recipe["AssetName"]!.Value<string>(),
            ["name"] = recipe["AssetName"]!.Value<string>(),
            ["machineId"] = ReferenceId(recipe["Crafter"]!),
            ["durationSeconds"] = DurationSeconds(recipe["CraftingTime"]!.Value<long>()),
            ["inputs"] = new JArray(Inputs(recipe)
                .Select(input => new JObject
                {
                    ["itemId"] = InputItemId(recipe, input),
                    ["quantity"] = input["Amount"]!.Value<long>().ToString(CultureInfo.InvariantCulture),
                })),
            ["outputs"] = Outputs(recipe),
            ["sourceAsset"] = recipe["SourceAsset"]!.Value<string>(),
        }).ToArray();

        var dataset = new JObject
        {
            ["schemaVersion"] = 1,
            ["game"] = new JObject
            {
                ["id"] = "Main Sequence",
                ["buildId"] = buildId,
                ["engineVersion"] = "5.7",
            },
            ["source"] = new JObject
            {
                ["kind"] = "game-import",
                ["importer"] = "MainSequence.Importer 1; CUE4Parse 1.2.2.202611",
                ["craftingTime"] = "durationSeconds = CraftingTime / 30; verified from Recipe:GetCraftingSeconds machine code",
                ["rawItems"] = "DAT_ItemRegistry Raw Resources category excluding ITEM_AnyItemFilter",
                ["itemOrder"] = "DAT_ItemRegistry ItemCategories order; unregistered items and machine items follow in stable asset-ID order",
                ["unregisteredItems"] = "Ordinary items absent from DAT_ItemRegistry remain computable but are hidden from item pickers",
                ["unsupportedRecipes"] = new JArray(unsupportedRecipes),
            },
            ["items"] = new JArray(items),
            ["machines"] = new JArray(machines),
            ["recipes"] = new JArray(recipes),
            ["rawItemIds"] = new JArray(rawItemIds),
        };

        var directory = Path.GetDirectoryName(Path.GetFullPath(outputPath));
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }
        var json = dataset.ToString(Formatting.Indented).Replace("\r\n", "\n", StringComparison.Ordinal);
        File.WriteAllText(outputPath, json + "\n", new System.Text.UTF8Encoding(false));
        Console.WriteLine($"Imported {items.Length} items, {machines.Length} machines, {recipes.Length} recipes.");
        Console.WriteLine($"Excluded {unsupportedRecipes.Length} unsupported recipes.");
        Console.WriteLine($"Dataset: {Path.GetFullPath(outputPath)}");
    }

    private static string VfsPath(string sourceAsset)
    {
        return sourceAsset.StartsWith("/Game/", StringComparison.Ordinal)
            ? $"MainSequence/Content/{sourceAsset["/Game/".Length..]}.uasset"
            : throw new InvalidDataException($"Unsupported source asset path: {sourceAsset}.");
    }

    private static JObject LoadExport(DefaultFileProvider provider, string path, string expectedType)
    {
        var export = provider.LoadPackage(path).GetExports()
            .Select(item => JObject.FromObject(item))
            .SingleOrDefault(item => item["Type"]?.Value<string>() == expectedType)
            ?? throw new InvalidDataException($"Expected one {expectedType} export in {path}.");
        var properties = export["Properties"] as JObject
            ?? throw new InvalidDataException($"Asset has no Properties field: {path}.");
        properties["AssetName"] = export["Name"]!.Value<string>();
        properties["SourceAsset"] = export["Package"]!.Value<string>();
        return properties;
    }

    private static string FindItemPath(DefaultFileProvider provider, string id)
    {
        var candidates = new[]
        {
            $"MainSequence/Content/Data/Items/{id}.uasset",
            $"MainSequence/Content/Data/Items/MachineItems/{id}.uasset",
        };
        return candidates.SingleOrDefault(provider.Files.ContainsKey)
            ?? throw new InvalidDataException($"Item asset not found or ambiguous: {id}.");
    }

    private static string FindBuildablePath(DefaultFileProvider provider, string crafterId)
    {
        var id = crafterId.Replace("CRAFT_", "DAT_", StringComparison.Ordinal);
        var direct = $"MainSequence/Content/Data/Buildables/{id}.uasset";
        if (provider.Files.ContainsKey(direct))
        {
            return direct;
        }
        var nonBuildable = $"MainSequence/Content/Data/Buildables/NonBuildable/{id}.uasset";
        return provider.Files.ContainsKey(nonBuildable) ? nonBuildable : direct;
    }

    private static string ItemName(
        DefaultFileProvider provider,
        string id,
        JObject item,
        IReadOnlyDictionary<string, JObject> buildables)
    {
        if (item["DisplayName"] is JObject displayName)
        {
            return Text(displayName);
        }
        var buildable = buildables.Values.SingleOrDefault(candidate => candidate["AssetName"]?.Value<string>() == id);
        if (buildable?["DisplayName"] is JObject buildableDisplayName)
        {
            return Text(buildableDisplayName);
        }
        var directPath = $"MainSequence/Content/Data/Buildables/{id}.uasset";
        if (provider.Files.ContainsKey(directPath))
        {
            return Text(LoadExport(provider, directPath, "Buildable")["DisplayName"]!);
        }
        if (item["Name"]?.Value<string>() is { Length: > 0 } sourceName)
        {
            return sourceName;
        }
        return item["AssetName"]?.Value<string>() is { Length: > 0 } assetName
            ? assetName
            : throw new InvalidDataException($"Item has no usable name: {id}.");
    }

    private static string Text(JToken token)
    {
        if (token is not JObject)
        {
            throw new InvalidDataException("Localized text is null or is not an object.");
        }
        return token["LocalizedString"]?.Value<string>()
            ?? token["CultureInvariantString"]?.Value<string>()
            ?? token["SourceString"]?.Value<string>()
            ?? throw new InvalidDataException("Localized text has no usable value.");
    }

    private static JArray Inputs(JObject recipe)
    {
        _ = recipe.Property("Inputs") ?? throw new InvalidDataException("Recipe has no Inputs field.");
        return recipe["Inputs"] as JArray ?? [];
    }

    private static string ReferenceId(JToken token)
    {
        var objectName = token["ObjectName"]?.Value<string>()
            ?? throw new InvalidDataException("Object reference has no ObjectName.");
        var parts = objectName.Split('\'');
        return parts.Length == 3 && parts[1].Length > 0
            ? parts[1]
            : throw new InvalidDataException($"Unsupported object reference: {objectName}.");
    }

    private static string? PowerKilowatts(JObject buildable)
    {
        var detail = buildable["ItemDetails"]?.SingleOrDefault(candidate =>
            candidate["DetailTypeText"]?["Key"]?.Value<string>() == "ConsumePower");
        if (detail is null)
        {
            return null;
        }
        var statValue = detail["StatValue"]?["CultureInvariantString"]?.Value<string>();
        var megawatts = statValue is null
            ? detail["FloatValue"]!.Value<decimal>()
            : decimal.Parse(statValue, NumberStyles.Float, CultureInfo.InvariantCulture);
        return (megawatts * 1000m).ToString("0.############################", CultureInfo.InvariantCulture);
    }

    private static string DurationSeconds(long craftingTime)
    {
        if (craftingTime <= 0)
        {
            throw new InvalidDataException("CraftingTime must be positive.");
        }
        var divisor = GreatestCommonDivisor(craftingTime, 30);
        var numerator = craftingTime / divisor;
        var denominator = 30 / divisor;
        return denominator == 1
            ? numerator.ToString(CultureInfo.InvariantCulture)
            : $"{numerator.ToString(CultureInfo.InvariantCulture)}/{denominator.ToString(CultureInfo.InvariantCulture)}";
    }

    private static long GreatestCommonDivisor(long left, long right)
    {
        while (right != 0)
        {
            (left, right) = (right, left % right);
        }
        return left;
    }

    private static void AssignShortCodes(IEnumerable<JObject> entities)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entity in entities.OrderBy(entity => entity["id"]!.Value<string>(), StringComparer.Ordinal))
        {
            var name = entity["name"]!.Value<string>()!;
            var words = name.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            var baseCode = words.Length > 1
                ? string.Concat(words.Take(2).Select(word => char.ToUpperInvariant(word[0])))
                : name.Length > 1 ? name[..2].ToUpperInvariant() : name.ToUpperInvariant();
            var code = baseCode;
            var suffix = 2;
            while (!used.Add(code))
            {
                code = baseCode + suffix.ToString(CultureInfo.InvariantCulture);
                suffix++;
            }
            entity["shortCode"] = code;
        }
    }
}
