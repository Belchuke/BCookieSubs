set -euo pipefail
cd "$(dirname "$0")/.."

python3 -m grpc_tools.protoc \
  -I proto \
  --python_out=workers/python/bcookiesubs_worker/generated \
  --grpc_python_out=workers/python/bcookiesubs_worker/generated \
  --pyi_out=workers/python/bcookiesubs_worker/generated \
  proto/worker_gateway.proto

sed -i '' 's/^import worker_gateway_pb2 as /from . import worker_gateway_pb2 as /' \
  workers/python/bcookiesubs_worker/generated/worker_gateway_pb2_grpc.py 2>/dev/null ||
  sed -i 's/^import worker_gateway_pb2 as /from . import worker_gateway_pb2 as /' \
    workers/python/bcookiesubs_worker/generated/worker_gateway_pb2_grpc.py

echo "generated: workers/python/bcookiesubs_worker/generated/"