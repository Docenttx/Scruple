# IAM for the rotation Function
#
# Dynamic Group: matches the Function's identity by resource.type = 'fnfunc'
# scoped to the signer compartment.
#
# Policy: least-privilege — read instances + instance pools; terminate
# instances tagged as pool members. No access to Vault, HSM, or Object
# Storage. The Function's only job is to terminate aged pool members.

variable "signer_dynamic_group_name" {
  type = string
  default = "scruple-signer-rotation-fn-dg"
}
variable "signer_policy_name" {
  type = string
  default = "scruple-signer-rotation-fn-policy"
}

resource "oci_identity_dynamic_group" "signer_rotation_fn" {
  compartment_id = var.tenancy_ocid   # dynamic groups are tenancy-scoped
  name = var.signer_dynamic_group_name
  description = "Rotation Function's runtime identity — terminates aged Signer CVMs"
  matching_rule = <<EOT
All {
  resource.type = 'fnfunc',
  resource.compartment.id = '${var.compartment_ocid}'
}
EOT
  freeform_tags = {
    "component" = "scruple-c2pa-signer"
    "purpose" = "L2-6.3.2-6.4.2-actuator-identity"
  }
}

resource "oci_identity_policy" "signer_rotation_fn" {
  compartment_id = var.tenancy_ocid
  name = var.signer_policy_name
  description = "Least-privilege policy for the Signer rotation Function"
  statements = [
    # Read the pool + its members
    "Allow dynamic-group ${oci_identity_dynamic_group.signer_rotation_fn.name} to read instance-pools in compartment id ${var.compartment_ocid}",
    "Allow dynamic-group ${oci_identity_dynamic_group.signer_rotation_fn.name} to read instances in compartment id ${var.compartment_ocid}",
    # Terminate individual instances tagged with rotation-managed=true
    # (the Instance Pool auto-replaces from the Instance Configuration)
    "Allow dynamic-group ${oci_identity_dynamic_group.signer_rotation_fn.name} to manage instances in compartment id ${var.compartment_ocid} where all {target.instance.tag.rotation-managed = 'true', request.operation = 'TerminateInstance'}",
    # Write logs
    "Allow dynamic-group ${oci_identity_dynamic_group.signer_rotation_fn.name} to use log-content in compartment id ${var.compartment_ocid}",
  ]
  freeform_tags = {
    "component" = "scruple-c2pa-signer"
  }
}

output "dynamic_group_ocid" {
  value = oci_identity_dynamic_group.signer_rotation_fn.id
}
