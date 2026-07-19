export const MessageEvent = {
  // Lifecycle
  INIT: "__INIT__",
  READY: "__READY__",
  // Child anuncia prontidão para receber INIT (handshake robusto a child tardio)
  CHILD_HELLO: "__CHILD_HELLO__",

  // Properties
  PROPS_UPDATE: "__PROPS_UPDATE__",

  // Events
  EVENT: "__EVENT__",
  CUSTOM_EVENT: "__CUSTOM_EVENT__",

  // Functions
  FUNCTION_CALL: "__FUNCTION_CALL__",
  FUNCTION_RESPONSE: "__FUNCTION_RESPONSE__",
  FUNCTION_RELEASE: "__FUNCTION_RELEASE__",
  FUNCTION_RELEASE_BATCH: "__FUNCTION_RELEASE_BATCH__",
} as const;

/**
 * Set of all valid message types for validation
 * Used to reject unknown/malicious message types
 */
export const VALID_MESSAGE_TYPES = new Set(Object.values(MessageEvent)) as Set<
  (typeof MessageEvent)[keyof typeof MessageEvent]
>;

/**
 * Function call timeout in milliseconds
 * Remote function calls will fail if they don't respond within this time
 */
export const FUNCTION_CALL_TIMEOUT = 5_000;

/**
 * Maximum depth for object serialization
 * Prevents stack overflow from deeply nested objects
 */
export const SERIALIZATION_MAX_DEPTH = 100;

/**
 * Maximum number of functions that can be registered
 * Prevents DoS via memory exhaustion from function registry
 */
export const FUNCTION_REGISTRY_MAX_SIZE = 1_000;

/**
 * Timeout for iframe load in milliseconds
 * Prevents indefinite waiting if iframe fails to load
 */
export const IFRAME_LOAD_TIMEOUT = 10_000;

/**
 * Default initialization timeout in milliseconds
 * Prevents indefinite waiting if INIT message is not received
 */
export const INIT_TIMEOUT = 10_000;

/**
 * Error message constants for consistent error handling
 */
export const ErrorMessages = {
  ARRAY_BOUNDS: "No MessagePort received in INIT message",
  DATA_CLONE_ERROR: "Cannot clone message data - unsupported type",
  FUNCTION_NOT_FOUND: "Function not found",
  FUNCTION_REGISTRY_EXCEEDED: "Function registry limit exceeded",
  FUNCTION_TIMEOUT: "Function call timeout",
  IFRAME_CONTENT_WINDOW: "Iframe contentWindow is not accessible",
  IFRAME_LOAD_FAILED: "Failed to load iframe",
  IFRAME_LOAD_TIMEOUT: "Iframe load timeout after 10s",
  INIT_TIMEOUT: "Initialization timeout: INIT message not received within timeout",
  INVALID_CUSTOM_EVENT_MESSAGE: "Invalid CUSTOM_EVENT message",
  INVALID_EVENT_MESSAGE: "Invalid EVENT message",
  INVALID_EVENT_NAME: "Invalid event name",
  INVALID_FUNCTION_CALL_MESSAGE: "Invalid FUNCTION_CALL message",
  INVALID_FUNCTION_RELEASE_BATCH_MESSAGE: "Invalid FUNCTION_RELEASE_BATCH message",
  INVALID_FUNCTION_RELEASE_MESSAGE: "Invalid FUNCTION_RELEASE message",
  INVALID_FUNCTION_RESPONSE_MESSAGE: "Invalid FUNCTION_RESPONSE message",
  INVALID_MESSAGE_FORMAT: "Invalid message format",
  INVALID_MESSAGE_TYPE: "Invalid message type (not a string)",
  INVALID_STATE_ERROR: "MessagePort is in invalid state (possibly closed)",
  MESSAGE_HANDLER_ERROR: "Error handling message from iframe",
  MESSAGE_SEND_FAILED: "Failed to send message",
  MISSING_REQUIRED_ATTRIBUTES: "Missing required attributes: name and src",
  PORT_NOT_READY: "MessagePort not ready",
  SERIALIZATION_DEPTH_EXCEEDED: "Serialization depth limit exceeded at level",
  UNKNOWN_ERROR: "Unknown error",
  UNKNOWN_MESSAGE_TYPE: "Unknown message type",
} as const;

/**
 * Warning message constants for consistent logging
 */
export const WarningMessages = {
  ALREADY_INITIALIZED: "Already initialized, ignoring duplicate call",
  DUPLICATE_INIT: "Ignoring duplicate INIT message",
  EVENT_CONFLICTS_BUILTIN: "Event name conflicts with built-in property",
  FORBIDDEN_ATTRIBUTE: "Forbidden attribute name",
  FORBIDDEN_EVENT: "Forbidden event name",
  RELEASE_ERROR: "Error sending release messages",
} as const;
