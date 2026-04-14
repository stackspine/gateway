# frozen_string_literal: true

require_relative "lib/stackspine/version"

Gem::Specification.new do |spec|
  spec.name          = "stackspine"
  spec.version       = StackSpine::VERSION
  spec.authors       = ["StackSpine"]
  spec.email         = ["support@stackspine.com"]

  spec.summary       = "Official Ruby SDK for StackSpine — Multi-Model AI Control Plane"
  spec.description   = "Ruby client for StackSpine with invoke, streaming (SSE), automatic retries, and full error handling."
  spec.homepage      = "https://github.com/stackspine/sdk-ruby"
  spec.license       = "MIT"
  spec.required_ruby_version = ">= 3.0"

  spec.metadata["homepage_uri"]    = spec.homepage
  spec.metadata["source_code_uri"] = spec.homepage
  spec.metadata["changelog_uri"]   = "#{spec.homepage}/blob/main/CHANGELOG.md"

  spec.files = Dir["lib/**/*.rb", "LICENSE", "README.md"]
  spec.require_paths = ["lib"]

  # Zero runtime dependencies — net/http, json, uri are all stdlib
end
