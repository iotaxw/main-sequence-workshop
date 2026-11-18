using System.Buffers.Binary;
using System.Runtime.InteropServices;
using AssetRipper.TextureDecoder.Bc;
using AssetRipper.TextureDecoder.Rgb.Formats;
using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Texture;
using Newtonsoft.Json.Linq;
using SkiaSharp;

namespace MainSequence.Importer;

public static class IconExporter
{
    public static string AssetPath(JToken reference)
    {
        var objectPath = reference["ObjectPath"]?.Value<string>()
            ?? throw new InvalidDataException("Icon reference has no ObjectPath.");
        if (!objectPath.StartsWith("/Game/", StringComparison.Ordinal))
        {
            throw new InvalidDataException($"Unsupported icon asset path: {objectPath}.");
        }
        var path = objectPath["/Game/".Length..];
        var suffix = path.LastIndexOf('.');
        if (suffix >= 0)
        {
            path = path[..suffix];
        }
        return $"MainSequence/Content/{path}.uasset";
    }

    public static void Export(DefaultFileProvider provider, JToken reference, string outputPath)
    {
        var assetPath = AssetPath(reference);
        var texture = provider.LoadPackageObject<UTexture2D>(assetPath[..^".uasset".Length]);
        var mip = texture.GetFirstMip()
            ?? throw new InvalidDataException($"Icon has no readable mip: {assetPath}.");
        var encoded = mip.BulkData?.Data
            ?? throw new InvalidDataException($"Icon has no pixel data: {assetPath}.");
        var (pixels, colorType) = DecodePixels(texture.Format, encoded, mip.SizeX, mip.SizeY, assetPath);
        var info = new SKImageInfo(mip.SizeX, mip.SizeY, colorType, SKAlphaType.Unpremul, SKColorSpace.CreateSrgb());
        using var bitmap = new SKBitmap();
        var handle = GCHandle.Alloc(pixels, GCHandleType.Pinned);
        try
        {
            bitmap.InstallPixels(info, handle.AddrOfPinnedObject(), info.RowBytes);
        }
        finally
        {
            handle.Free();
        }
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath))!);
        if (File.Exists(outputPath) && File.ReadAllBytes(outputPath).SequenceEqual(data.ToArray()))
        {
            return;
        }
        var temporaryPath = outputPath + ".tmp";
        using (var stream = File.Create(temporaryPath))
        {
            data.SaveTo(stream);
        }
        File.Move(temporaryPath, outputPath, true);
    }

    private static (byte[] Pixels, SKColorType ColorType) DecodePixels(
        EPixelFormat format,
        byte[] encoded,
        int width,
        int height,
        string assetPath)
    {
        switch (format)
        {
            case EPixelFormat.PF_FloatRGBA:
                return (ConvertLinearRgbaF16(encoded, width, height, assetPath), SKColorType.Rgba8888);
            case EPixelFormat.PF_B8G8R8A8:
                return (encoded, SKColorType.Bgra8888);
            case EPixelFormat.PF_R8G8B8A8:
                return (encoded, SKColorType.Rgba8888);
            case EPixelFormat.PF_DXT1:
                Bc1.Decompress<ColorRGBA<byte>, byte>(encoded, width, height, out var bc1);
                return (bc1, SKColorType.Rgba8888);
            case EPixelFormat.PF_DXT3:
                Bc2.Decompress<ColorRGBA<byte>, byte>(encoded, width, height, out var bc2);
                return (bc2, SKColorType.Rgba8888);
            case EPixelFormat.PF_DXT5:
                Bc3.Decompress<ColorRGBA<byte>, byte>(encoded, width, height, out var bc3);
                return (bc3, SKColorType.Rgba8888);
            case EPixelFormat.PF_BC7:
                Bc7.Decompress<ColorRGBA<byte>, byte>(encoded, width, height, out var bc7);
                return (bc7, SKColorType.Rgba8888);
            default:
                throw new InvalidDataException($"Unsupported icon pixel format {format}: {assetPath}.");
        }
    }

    private static byte[] ConvertLinearRgbaF16(byte[] encoded, int width, int height, string assetPath)
    {
        var pixelCount = checked(width * height);
        if (encoded.Length != checked(pixelCount * 8))
        {
            throw new InvalidDataException($"Unexpected RGBA F16 data length: {assetPath}.");
        }
        var pixels = new byte[checked(pixelCount * 4)];
        for (var pixel = 0; pixel < pixelCount; pixel++)
        {
            for (var channel = 0; channel < 4; channel++)
            {
                var sourceOffset = pixel * 8 + channel * 2;
                var bits = BinaryPrimitives.ReadInt16LittleEndian(encoded.AsSpan(sourceOffset, 2));
                var value = (float)BitConverter.Int16BitsToHalf(bits);
                if (!float.IsFinite(value))
                {
                    throw new InvalidDataException($"Non-finite icon pixel: {assetPath}.");
                }
                value = Math.Clamp(value, 0f, 1f);
                if (channel < 3)
                {
                    value = value <= 0.0031308f
                        ? value * 12.92f
                        : 1.055f * MathF.Pow(value, 1f / 2.4f) - 0.055f;
                }
                pixels[pixel * 4 + channel] = (byte)MathF.Round(value * 255f, MidpointRounding.AwayFromZero);
            }
        }
        return pixels;
    }
}
