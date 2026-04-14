# frozen_string_literal: true

require "json"

module StackSpine
  module Streaming
    module_function

    # Parse a single SSE event from the buffer.
    # Returns [event_or_nil, remainder].
    def parse_sse_event(buffer)
      idx = buffer.index("\n\n")
      return [nil, buffer] if idx.nil?

      raw_event = buffer[0...idx]
      remainder = buffer[(idx + 2)..]

      event_name = nil
      event_id   = nil
      event_type = nil
      data_lines = []

      raw_event.each_line do |line|
        line = line.chomp
        next if line.empty? || line.start_with?(":")

        if line.include?(":")
          field, value = line.split(":", 2)
          value = value.lstrip
        else
          field = line
          value = ""
        end

        case field
        when "event" then event_name = value
        when "id"    then event_id   = value
        when "type"  then event_type = value
        when "data"  then data_lines << value
        end
      end

      data_str = data_lines.join("\n").strip

      if data_str.empty? || data_str == "[DONE]"
        ev = StreamEvent.new(type: event_type || event_name || "done", data: {})
        return [ev, remainder]
      end

      data = begin
        decoded = JSON.parse(data_str)
        decoded.is_a?(Hash) ? decoded : { "value" => decoded }
      rescue JSON::ParserError
        { "text" => data_str }
      end

      ev = StreamEvent.new(
        type:  event_type || event_name || "message",
        data:  data,
        id:    event_id,
        event: event_name
      )
      [ev, remainder]
    end

    # Yields StreamEvent objects from an IO or block that yields chunks.
    def each_sse_event(enum, &block)
      buffer = ""

      enum.each do |chunk|
        next if chunk.nil? || chunk.empty?

        buffer += chunk.force_encoding("UTF-8")

        loop do
          ev, buffer = parse_sse_event(buffer)
          break if ev.nil?

          block.call(ev)
        end
      end
    end
  end
end
