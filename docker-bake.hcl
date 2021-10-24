variable "DEFAULT_TAG" {
  default = ["sparanoid/a-soul:local"]
}

# Special target: https://github.com/docker/metadata-action#bake-definition
target "docker-metadata-action" {
  context = "./packages/core"
  tags = "${DEFAULT_TAG}"
}

# Default target if none specified
group "default" {
  targets = ["build-local"]
}

target "build" {
  inherits = ["docker-metadata-action"]
}

target "build-local" {
  inherits = ["build"]
  output = ["type=docker"]
}

target "build-all" {
  inherits = ["build"]
  platforms = [
    "linux/amd64",
    "linux/arm/v6",
    "linux/arm/v7",
    "linux/arm64/v8",
    "linux/arm64",
  ]
}
