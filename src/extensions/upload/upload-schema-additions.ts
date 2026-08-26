// Upload SCHEMA ADDITIONS: the server-managed background metadata columns
// on plugin::upload.file. One of the modules split out of strapi-server.ts.

export function applyUploadSchemaAdditions(plugin: any): void {
  // Extend upload.file itself so the calculated value is persisted and
  // exposed wherever media is populated. The upload controllers only permit
  // their standard metadata fields, so this remains server-managed.
  plugin.contentTypes.file.schema.attributes.backgroundColour = {
    type: 'string',
    configurable: false,
    minLength: 7,
    maxLength: 7,
    regex: '^#[0-9A-F]{6}$',
  };
  plugin.contentTypes.file.schema.attributes.backgroundRemovalSourceHash = {
    type: 'string',
    configurable: false,
    private: true,
    maxLength: 64,
  };
  plugin.contentTypes.file.schema.attributes.backgroundRemovalVersion = {
    type: 'string',
    configurable: false,
    private: true,
    maxLength: 80,
  };
  plugin.contentTypes.file.schema.attributes.backgroundRemovedAt = {
    type: 'datetime',
    configurable: false,
    private: true,
  };
}
