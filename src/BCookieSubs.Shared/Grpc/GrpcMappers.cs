using BCookieSubs.Shared.Database.Entities;

namespace BCookieSubs.Shared.Grpc;

public static class GrpcMappers
{
    public static WorkerHardwareInformation ToHardware(this WorkerHardware? hardware)
    {
        if (hardware is null)
        {
            return new WorkerHardwareInformation();
        }

        return new WorkerHardwareInformation
        {
            OperatingSystem = hardware.Os,
            Architecture = hardware.Architecture,
            CpuModel = hardware.CpuModel,
            CpuCores = hardware.CpuCores,
            RamBytes = hardware.RamBytes,
            GpuVendor = hardware.GpuVendor,
            GpuModel = hardware.GpuModel,
            GpuVramBytes = hardware.GpuVramBytes == 0 ? null : hardware.GpuVramBytes,
            CudaAvailable = hardware.CudaAvailable,
            PythonVersion = hardware.PythonVersion
        };
    }

    public static WorkerHardware ToMessage(this WorkerHardwareInformation hardware) => new()
    {
        Os = hardware.OperatingSystem ?? "",
        Architecture = hardware.Architecture ?? "",
        CpuModel = hardware.CpuModel ?? "",
        CpuCores = hardware.CpuCores,
        RamBytes = hardware.RamBytes,
        GpuVendor = hardware.GpuVendor ?? "",
        GpuModel = hardware.GpuModel ?? "",
        GpuVramBytes = hardware.GpuVramBytes ?? 0,
        CudaAvailable = hardware.CudaAvailable,
        PythonVersion = hardware.PythonVersion ?? ""
    };
}