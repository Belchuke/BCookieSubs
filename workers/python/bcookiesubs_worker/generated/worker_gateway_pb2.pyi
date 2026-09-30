from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class WorkerHardware(_message.Message):
    __slots__ = ("os", "architecture", "cpu_model", "cpu_cores", "ram_bytes", "gpu_vendor", "gpu_model", "gpu_vram_bytes", "cuda_available", "python_version")
    OS_FIELD_NUMBER: _ClassVar[int]
    ARCHITECTURE_FIELD_NUMBER: _ClassVar[int]
    CPU_MODEL_FIELD_NUMBER: _ClassVar[int]
    CPU_CORES_FIELD_NUMBER: _ClassVar[int]
    RAM_BYTES_FIELD_NUMBER: _ClassVar[int]
    GPU_VENDOR_FIELD_NUMBER: _ClassVar[int]
    GPU_MODEL_FIELD_NUMBER: _ClassVar[int]
    GPU_VRAM_BYTES_FIELD_NUMBER: _ClassVar[int]
    CUDA_AVAILABLE_FIELD_NUMBER: _ClassVar[int]
    PYTHON_VERSION_FIELD_NUMBER: _ClassVar[int]
    os: str
    architecture: str
    cpu_model: str
    cpu_cores: int
    ram_bytes: int
    gpu_vendor: str
    gpu_model: str
    gpu_vram_bytes: int
    cuda_available: bool
    python_version: str
    def __init__(self, os: _Optional[str] = ..., architecture: _Optional[str] = ..., cpu_model: _Optional[str] = ..., cpu_cores: _Optional[int] = ..., ram_bytes: _Optional[int] = ..., gpu_vendor: _Optional[str] = ..., gpu_model: _Optional[str] = ..., gpu_vram_bytes: _Optional[int] = ..., cuda_available: _Optional[bool] = ..., python_version: _Optional[str] = ...) -> None: ...

class ClientMessage(_message.Message):
    __slots__ = ("enroll", "auth", "heartbeat", "disconnect", "job_progress", "job_result")
    ENROLL_FIELD_NUMBER: _ClassVar[int]
    AUTH_FIELD_NUMBER: _ClassVar[int]
    HEARTBEAT_FIELD_NUMBER: _ClassVar[int]
    DISCONNECT_FIELD_NUMBER: _ClassVar[int]
    JOB_PROGRESS_FIELD_NUMBER: _ClassVar[int]
    JOB_RESULT_FIELD_NUMBER: _ClassVar[int]
    enroll: EnrollRequest
    auth: AuthRequest
    heartbeat: Heartbeat
    disconnect: Disconnect
    job_progress: JobProgress
    job_result: JobResult
    def __init__(self, enroll: _Optional[_Union[EnrollRequest, _Mapping]] = ..., auth: _Optional[_Union[AuthRequest, _Mapping]] = ..., heartbeat: _Optional[_Union[Heartbeat, _Mapping]] = ..., disconnect: _Optional[_Union[Disconnect, _Mapping]] = ..., job_progress: _Optional[_Union[JobProgress, _Mapping]] = ..., job_result: _Optional[_Union[JobResult, _Mapping]] = ...) -> None: ...

class EnrollRequest(_message.Message):
    __slots__ = ("enrollment_token", "worker_name", "machine_identifier", "worker_version", "capabilities", "max_concurrency", "hardware")
    ENROLLMENT_TOKEN_FIELD_NUMBER: _ClassVar[int]
    WORKER_NAME_FIELD_NUMBER: _ClassVar[int]
    MACHINE_IDENTIFIER_FIELD_NUMBER: _ClassVar[int]
    WORKER_VERSION_FIELD_NUMBER: _ClassVar[int]
    CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    HARDWARE_FIELD_NUMBER: _ClassVar[int]
    enrollment_token: str
    worker_name: str
    machine_identifier: str
    worker_version: str
    capabilities: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    hardware: WorkerHardware
    def __init__(self, enrollment_token: _Optional[str] = ..., worker_name: _Optional[str] = ..., machine_identifier: _Optional[str] = ..., worker_version: _Optional[str] = ..., capabilities: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ..., hardware: _Optional[_Union[WorkerHardware, _Mapping]] = ...) -> None: ...

class AuthRequest(_message.Message):
    __slots__ = ("worker_id", "worker_secret", "machine_identifier", "worker_version", "capabilities", "max_concurrency", "hardware")
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    WORKER_SECRET_FIELD_NUMBER: _ClassVar[int]
    MACHINE_IDENTIFIER_FIELD_NUMBER: _ClassVar[int]
    WORKER_VERSION_FIELD_NUMBER: _ClassVar[int]
    CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    HARDWARE_FIELD_NUMBER: _ClassVar[int]
    worker_id: int
    worker_secret: str
    machine_identifier: str
    worker_version: str
    capabilities: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    hardware: WorkerHardware
    def __init__(self, worker_id: _Optional[int] = ..., worker_secret: _Optional[str] = ..., machine_identifier: _Optional[str] = ..., worker_version: _Optional[str] = ..., capabilities: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ..., hardware: _Optional[_Union[WorkerHardware, _Mapping]] = ...) -> None: ...

class Heartbeat(_message.Message):
    __slots__ = ("ready", "active_jobs", "sent_at_unix", "cpu_utilization", "memory_utilization")
    READY_FIELD_NUMBER: _ClassVar[int]
    ACTIVE_JOBS_FIELD_NUMBER: _ClassVar[int]
    SENT_AT_UNIX_FIELD_NUMBER: _ClassVar[int]
    CPU_UTILIZATION_FIELD_NUMBER: _ClassVar[int]
    MEMORY_UTILIZATION_FIELD_NUMBER: _ClassVar[int]
    ready: bool
    active_jobs: int
    sent_at_unix: int
    cpu_utilization: float
    memory_utilization: float
    def __init__(self, ready: _Optional[bool] = ..., active_jobs: _Optional[int] = ..., sent_at_unix: _Optional[int] = ..., cpu_utilization: _Optional[float] = ..., memory_utilization: _Optional[float] = ...) -> None: ...

class Disconnect(_message.Message):
    __slots__ = ("reason",)
    REASON_FIELD_NUMBER: _ClassVar[int]
    reason: str
    def __init__(self, reason: _Optional[str] = ...) -> None: ...

class ServerMessage(_message.Message):
    __slots__ = ("enroll_result", "auth_result", "ack", "config_update", "drain", "resume", "disconnect", "job", "job_cancel")
    ENROLL_RESULT_FIELD_NUMBER: _ClassVar[int]
    AUTH_RESULT_FIELD_NUMBER: _ClassVar[int]
    ACK_FIELD_NUMBER: _ClassVar[int]
    CONFIG_UPDATE_FIELD_NUMBER: _ClassVar[int]
    DRAIN_FIELD_NUMBER: _ClassVar[int]
    RESUME_FIELD_NUMBER: _ClassVar[int]
    DISCONNECT_FIELD_NUMBER: _ClassVar[int]
    JOB_FIELD_NUMBER: _ClassVar[int]
    JOB_CANCEL_FIELD_NUMBER: _ClassVar[int]
    enroll_result: EnrollResult
    auth_result: AuthResult
    ack: Ack
    config_update: ConfigUpdate
    drain: DrainCommand
    resume: ResumeCommand
    disconnect: ServerDisconnect
    job: JobAssignment
    job_cancel: JobCancel
    def __init__(self, enroll_result: _Optional[_Union[EnrollResult, _Mapping]] = ..., auth_result: _Optional[_Union[AuthResult, _Mapping]] = ..., ack: _Optional[_Union[Ack, _Mapping]] = ..., config_update: _Optional[_Union[ConfigUpdate, _Mapping]] = ..., drain: _Optional[_Union[DrainCommand, _Mapping]] = ..., resume: _Optional[_Union[ResumeCommand, _Mapping]] = ..., disconnect: _Optional[_Union[ServerDisconnect, _Mapping]] = ..., job: _Optional[_Union[JobAssignment, _Mapping]] = ..., job_cancel: _Optional[_Union[JobCancel, _Mapping]] = ...) -> None: ...

class JobAssignment(_message.Message):
    __slots__ = ("job_id", "job_type", "payload")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    JOB_TYPE_FIELD_NUMBER: _ClassVar[int]
    PAYLOAD_FIELD_NUMBER: _ClassVar[int]
    job_id: int
    job_type: str
    payload: str
    def __init__(self, job_id: _Optional[int] = ..., job_type: _Optional[str] = ..., payload: _Optional[str] = ...) -> None: ...

class JobCancel(_message.Message):
    __slots__ = ("job_id", "reason")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    job_id: int
    reason: str
    def __init__(self, job_id: _Optional[int] = ..., reason: _Optional[str] = ...) -> None: ...

class JobProgress(_message.Message):
    __slots__ = ("job_id", "progress", "status")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    PROGRESS_FIELD_NUMBER: _ClassVar[int]
    STATUS_FIELD_NUMBER: _ClassVar[int]
    job_id: int
    progress: int
    status: str
    def __init__(self, job_id: _Optional[int] = ..., progress: _Optional[int] = ..., status: _Optional[str] = ...) -> None: ...

class JobResult(_message.Message):
    __slots__ = ("job_id", "success", "result", "error_code", "error_message")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    RESULT_FIELD_NUMBER: _ClassVar[int]
    ERROR_CODE_FIELD_NUMBER: _ClassVar[int]
    ERROR_MESSAGE_FIELD_NUMBER: _ClassVar[int]
    job_id: int
    success: bool
    result: str
    error_code: str
    error_message: str
    def __init__(self, job_id: _Optional[int] = ..., success: _Optional[bool] = ..., result: _Optional[str] = ..., error_code: _Optional[str] = ..., error_message: _Optional[str] = ...) -> None: ...

class EnrollResult(_message.Message):
    __slots__ = ("success", "message", "worker_id", "worker_secret", "assigned_name", "token")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    WORKER_ID_FIELD_NUMBER: _ClassVar[int]
    WORKER_SECRET_FIELD_NUMBER: _ClassVar[int]
    ASSIGNED_NAME_FIELD_NUMBER: _ClassVar[int]
    TOKEN_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    worker_id: int
    worker_secret: str
    assigned_name: str
    token: str
    def __init__(self, success: _Optional[bool] = ..., message: _Optional[str] = ..., worker_id: _Optional[int] = ..., worker_secret: _Optional[str] = ..., assigned_name: _Optional[str] = ..., token: _Optional[str] = ...) -> None: ...

class AuthResult(_message.Message):
    __slots__ = ("success", "message", "token")
    SUCCESS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    TOKEN_FIELD_NUMBER: _ClassVar[int]
    success: bool
    message: str
    token: str
    def __init__(self, success: _Optional[bool] = ..., message: _Optional[str] = ..., token: _Optional[str] = ...) -> None: ...

class Ack(_message.Message):
    __slots__ = ("message",)
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    message: str
    def __init__(self, message: _Optional[str] = ...) -> None: ...

class ConfigUpdate(_message.Message):
    __slots__ = ("allowed_capabilities", "heartbeat_interval_seconds", "draining")
    ALLOWED_CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    HEARTBEAT_INTERVAL_SECONDS_FIELD_NUMBER: _ClassVar[int]
    DRAINING_FIELD_NUMBER: _ClassVar[int]
    allowed_capabilities: _containers.RepeatedScalarFieldContainer[str]
    heartbeat_interval_seconds: int
    draining: bool
    def __init__(self, allowed_capabilities: _Optional[_Iterable[str]] = ..., heartbeat_interval_seconds: _Optional[int] = ..., draining: _Optional[bool] = ...) -> None: ...

class DrainCommand(_message.Message):
    __slots__ = ("reason",)
    REASON_FIELD_NUMBER: _ClassVar[int]
    reason: str
    def __init__(self, reason: _Optional[str] = ...) -> None: ...

class ResumeCommand(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class ServerDisconnect(_message.Message):
    __slots__ = ("reason",)
    REASON_FIELD_NUMBER: _ClassVar[int]
    reason: str
    def __init__(self, reason: _Optional[str] = ...) -> None: ...
