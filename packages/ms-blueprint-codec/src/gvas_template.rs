use serde_json::{json, Value};

/// Verified UE 5.7 GVAS Header matching Main Sequence Build 26639889 DesignSaveGame files.
pub fn default_gvas_header() -> Value {
    json!({
        "magic": 1396790855,
        "save_game_version": 3,
        "package_version": { "ue4": 522, "ue5": 1018 },
        "engine_version_major": 5,
        "engine_version_minor": 7,
        "engine_version_patch": 4,
        "engine_version_build": 51494982,
        "engine_version": "++UE5+Release-5.7",
        "custom_version": [
            3,
            [
                { "id": "9c54d522-a826-4fbe-9421-074661b482d0", "value": 44 },
                { "id": "62915ca3-1c8e-4bf7-a30e-12c7c8219df7", "value": 43 },
                { "id": "cc400d24-e0e9-4e7b-9bf9-a283dcc0c027", "value": 0 },
                { "id": "b0d832e4-1f89-4f0d-accf-7eb736fd4aa2", "value": 10 },
                { "id": "e1c64328-a22c-4d53-a36c-8e866417bd8c", "value": 0 },
                { "id": "375ec13c-06e4-48fb-b500-84f0262a717e", "value": 4 },
                { "id": "e4b068ed-f494-42e9-a231-da0b2e46bb41", "value": 40 },
                { "id": "cffc743f-43b0-4480-9391-14df171d2073", "value": 37 },
                { "id": "b02b49b5-bb20-44e9-a304-32b752e40360", "value": 3 },
                { "id": "a4e4105c-59a1-49b5-a7c5-40c4547edfee", "value": 0 },
                { "id": "39c831c9-5ae6-47dc-9a44-9c173e1c8e7c", "value": 0 },
                { "id": "78f01b33-ebea-4f98-b9b4-84eaccb95aa2", "value": 20 },
                { "id": "6631380f-2d4d-43e0-8009-cf276956a95a", "value": 0 },
                { "id": "12f88b9f-8875-4afc-a67c-d90c383abd29", "value": 49 },
                { "id": "7b5ae74c-d270-4c10-a958-57980b212a5a", "value": 13 },
                { "id": "d7296918-1dd6-4bdd-9de2-64a83cc13884", "value": 3 },
                { "id": "c2a15278-bfe7-4afe-6c17-90ff531df755", "value": 1 },
                { "id": "6eaca3d4-40ec-4cc1-b786-8bed09428fc5", "value": 3 },
                { "id": "29e575dd-e0a3-4627-9d10-d276232cdcea", "value": 17 },
                { "id": "af43a65d-7fd3-4947-9873-3e8ed9c1bb05", "value": 15 },
                { "id": "6b266cec-1ec7-4b8f-a30b-e4d90942fc07", "value": 1 },
                { "id": "0df73d61-a23f-47ea-b727-89e90c41499a", "value": 1 },
                { "id": "601d1886-ac64-4f84-aa16-d3de0deac7d6", "value": 225 },
                { "id": "8dbc2c5b-54a7-43e0-a768-fcbb7da29060", "value": 8 },
                { "id": "5b4c06b7-2463-4af8-805b-bf70cdf5d0dd", "value": 15 },
                { "id": "e7086368-6b23-4c58-8439-1b7016265e91", "value": 17 },
                { "id": "9dffbcd6-494f-0158-e221-12823c92a888", "value": 11 },
                { "id": "f2aed0ac-9afe-416f-8664-aa7ffa26d6fc", "value": 1 },
                { "id": "174f1f0b-b4c6-45a5-b13f-2ee8d0fb917d", "value": 10 },
                { "id": "35f94a83-e258-406c-a318-09f59610247c", "value": 41 },
                { "id": "b68fc16e-8b1b-42e2-b453-215c058844fe", "value": 1 },
                { "id": "b2e18506-4273-cfc2-a54e-f4bb758bba07", "value": 1 },
                { "id": "64f58936-fd1b-42ba-ba96-7289d5d0fa4e", "value": 1 },
                { "id": "697dd581-e64f-41ab-aa4a-51ecbeb7b628", "value": 121 },
                { "id": "d89b5e42-24bd-4d46-8412-aca8df641779", "value": 61 },
                { "id": "59da5d52-1232-4948-b878-597870b8e98b", "value": 9 },
                { "id": "6f0ed827-a609-4895-9c91-998d90180ea4", "value": 2 },
                { "id": "30d58be3-95ea-4282-a6e3-b159d8ebb06a", "value": 1 },
                { "id": "717f9ee7-e9b0-493a-88b3-91321b388107", "value": 22 },
                { "id": "e21e1caa-af47-425e-89bf-6ad44c44a8bb", "value": 0 },
                { "id": "134a157e-d5e2-49a3-8d4e-843c98fe9e31", "value": 3 },
                { "id": "68c409fc-7095-4986-8963-acd2c4865183", "value": 3 },
                { "id": "9513202e-eba1-b279-f17f-e5baab90c3f2", "value": 4 },
                { "id": "430c4d19-7154-4970-8769-9b69df90b0e5", "value": 15 },
                { "id": "aafe32bd-5395-4c14-b66a-5e251032d1dd", "value": 1 },
                { "id": "12345678-1234-5678-1234-567812345678", "value": 5 },
                { "id": "23afe18e-4ce1-4e58-8d61-c252b953beb7", "value": 11 },
                { "id": "a462b7ea-f499-4e3a-99c1-ec1f8224e1b2", "value": 4 },
                { "id": "2eb5fdbd-01ac-4d10-8136-f38f3393a5da", "value": 5 },
                { "id": "509d354f-f6e6-492f-a749-85b2073c631c", "value": 0 },
                { "id": "95a4f03e-7e0b-49e4-ba43-d35694ff87d9", "value": 7 },
                { "id": "b6e31b1c-d29f-11ec-857e-9f856f9970e2", "value": 1 },
                { "id": "4a56eb40-10f5-11dc-92d3-347eb2c96ae7", "value": 3 },
                { "id": "8417998a-bbc0-43ec-81b3-d119072d2722", "value": 19 },
                { "id": "d78a4a00-e858-4697-baa8-19b5487d46b4", "value": 18 },
                { "id": "5579f886-933a-4c1f-83ba-087b6361b92f", "value": 2 },
                { "id": "612fbe52-da53-400b-910d-4f919fb1857c", "value": 1 },
                { "id": "79d25301-47af-41f8-adcf-10e797415c16", "value": 2 },
                { "id": "a4237a36-caea-41c9-8fa2-18f858681bf3", "value": 5 },
                { "id": "804e3f75-7088-4b49-a4d6-8c063c7eb6dc", "value": 5 },
                { "id": "1ed048f4-2f2e-4c68-89d0-53a4f18f102d", "value": 1 },
                { "id": "fb680af2-59ef-4ba3-baa8-19b573c8443d", "value": 2 },
                { "id": "9950b70e-b41a-4e17-bbcc-fa0d57817fd6", "value": 1 },
                { "id": "76a52329-0923-45b5-98ae-d841cf2f6ad8", "value": 5 },
                { "id": "5fbc6907-55c8-40ae-8e67-f1845efff13f", "value": 1 },
                { "id": "81a1b2b3-af12-7711-e211-b0b21d235409", "value": 1 },
                { "id": "fcf57afa-5076-4283-b9a9-e658ffa02d32", "value": 93 },
                { "id": "0925477b-763d-4001-9d91-d6730b75b411", "value": 1 },
                { "id": "4288211b-4548-16c6-1a76-67b2507a2a00", "value": 1 },
                { "id": "6304a3e7-0059-4f59-8cfc-21bd7721fd4e", "value": 0 },
                { "id": "dc49959b-53c0-4de7-9156-ea885e7c5d39", "value": 19 },
                { "id": "a7820cfb-20a7-4359-8c54-2c149623cf50", "value": 40 },
                { "id": "93ede1aa-10ca-7375-4df9-8a2849b157a0", "value": 14 },
                { "id": "11310aed-2e55-4d61-af67-9aa3c5a1082c", "value": 17 },
                { "id": "f6dfbb78-bb50-a0e4-4018-b84d60cbaf23", "value": 11 },
                { "id": "82e77c4e-3323-43a5-b46b-13c597310df3", "value": 0 },
                { "id": "28e21331-501f-4723-8110-fa64ea10da1e", "value": 18 },
                { "id": "60c4f0de-8b26-4c34-aa93-72015dff09cc", "value": 1 },
                { "id": "5426c227-4b31-45b2-9b9b-ed1f327fb126", "value": 1 },
                { "id": "24bb7af3-5646-4f83-1f2f-2dc249ad96ff", "value": 5 },
                { "id": "92738c43-2988-4d9c-9a3d-9bbe6eff9fc0", "value": 3 },
                { "id": "b69d2e47-e2a8-4003-bf77-18a492c4d899", "value": 1 }
            ]
        ]
    })
}

pub fn default_colour_palettes() -> Value {
    json!([
        {
            "MaterialType_0": 0,
            "Colour0_0": { "r": 225, "g": 225, "b": 225, "a": 255 },
            "Colour1_0": { "r": 137, "g": 137, "b": 137, "a": 255 },
            "Colour2_0": { "r": 39, "g": 39, "b": 39, "a": 255 },
            "Colour3_0": { "r": 61, "g": 120, "b": 188, "a": 255 }
        }
    ])
}

/// Exact uesave 0.7.1 property schema map for Main Sequence Build 26639889 DesignSaveGame.
pub fn default_design_save_schemas() -> Value {
    let z = "00000000-0000-0000-0000-000000000000";
    let gt = json!({ "data": { "Struct": { "struct_type": { "Struct": "/Script/MainSequence.GridTransform" }, "id": z } } });
    let ip = json!({ "data": { "Struct": { "struct_type": "IntPoint", "id": z } } });
    let intp = json!({ "data": { "Other": "IntProperty" } });
    let objp = json!({ "data": { "Other": "ObjectProperty" } });
    let col = json!({ "data": { "Struct": { "struct_type": "Color", "id": z } } });
    let barr = json!({ "data": { "Array": { "Byte": null } } });
    let earr = json!({ "data": { "Array": { "Struct": { "struct_type": { "Struct": "/Script/MainSequence.BuildBlueprintEntry" }, "id": z } } } });
    let marr = json!({ "data": { "Array": { "Struct": { "struct_type": { "Struct": "/Script/MainSequence.BuildBlueprintMachine" }, "id": z } } } });

    json!({
        "schemas": {
            "Blueprint": { "data": { "Struct": { "struct_type": { "Struct": "/Script/MainSequence.BuildBlueprint" }, "id": z } } },
            "Blueprint.Blocks": earr,
            "Blueprint.Blocks.BlockID": intp,
            "Blueprint.Blocks.Class": objp,
            "Blueprint.Blocks.DefaultMachines": marr,
            "Blueprint.Blocks.DefaultMachines.Class": objp,
            "Blueprint.Blocks.DefaultMachines.MachineID": intp,
            "Blueprint.Blocks.DefaultMachines.PaletteID": intp,
            "Blueprint.Blocks.DefaultMachines.SerializedMachineConfig": barr,
            "Blueprint.Blocks.DefaultMachines.Transform": gt,
            "Blueprint.Blocks.DefaultMachines.Transform.GridLocation": ip,
            "Blueprint.Blocks.DefaultMachines.Transform.GridRotation": intp,
            "Blueprint.Blocks.DefaultMachines.Transform.Height": intp,
            "Blueprint.Blocks.PaletteID": intp,
            "Blueprint.Blocks.Transform": gt,
            "Blueprint.Blocks.Transform.GridLocation": ip,
            "Blueprint.Blocks.Transform.GridRotation": intp,
            "Blueprint.Blocks.Transform.Height": intp,
            "Blueprint.CameraLocation": { "data": { "Struct": { "struct_type": "Vector", "id": z } } },
            "Blueprint.CameraRotation": { "data": { "Struct": { "struct_type": "Rotator", "id": z } } },
            "Blueprint.ColourPalettes": { "data": { "Array": { "Struct": { "struct_type": { "Struct": "/Script/MainSequence.ColourPalette" }, "id": z } } } },
            "Blueprint.ColourPalettes.Colour0": col,
            "Blueprint.ColourPalettes.Colour1": col,
            "Blueprint.ColourPalettes.Colour2": col,
            "Blueprint.ColourPalettes.Colour3": col,
            "Blueprint.ColourPalettes.MaterialType": intp,
            "Blueprint.Connectors": earr,
            "Blueprint.Connectors.BlockID": intp,
            "Blueprint.Connectors.Class": objp,
            "Blueprint.Connectors.DefaultMachines": marr,
            "Blueprint.Connectors.PaletteID": intp,
            "Blueprint.Connectors.Transform": gt,
            "Blueprint.Connectors.Transform.GridLocation": ip,
            "Blueprint.Connectors.Transform.GridRotation": intp,
            "Blueprint.Connectors.Transform.Height": intp,
            "Blueprint.DisplayName": { "data": { "Other": "TextProperty" } },
            "Blueprint.Machines": marr,
            "Blueprint.Machines.Class": objp,
            "Blueprint.Machines.MachineID": intp,
            "Blueprint.Machines.PaletteID": intp,
            "Blueprint.Machines.SerializedMachineConfig": barr,
            "Blueprint.Machines.Transform": gt,
            "Blueprint.Machines.Transform.GridLocation": ip,
            "Blueprint.Machines.Transform.GridRotation": intp,
            "Blueprint.Machines.Transform.Height": intp,
            "Blueprint.Screenshot": { "data": { "Struct": { "struct_type": { "Struct": "/Script/MainSequence.BlueprintScreenshot" }, "id": z } } },
            "Blueprint.Screenshot.Dimensions": ip,
            "Blueprint.Screenshot.GreyscaleValues": { "data": { "Array": { "Other": "IntProperty" } } },
            "Blueprint.Type": { "data": { "Enum": ["/Script/MainSequence.EBuildingFrameType", "ByteProperty"] } },
            "Blueprint.Version": intp
        }
    })
}
