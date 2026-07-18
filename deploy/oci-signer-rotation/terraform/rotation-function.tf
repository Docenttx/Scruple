# Signer rotation Function + Scheduler
#
# OCI Resource Scheduler fires the Function every 6 hours. The Function
# enumerates Signer Instance Pool members, computes age from OCI Compute
# API's `time_created`, and terminates any instance with age > 60 days.
# The Instance Pool auto-provisions a replacement from the current
# Instance Configuration.
#
# Companion:
#   iam-policies.tf — Dynamic Group + Policy granting the Function
#                     compute:instance:read + compute:instance:delete +
#                     compute:instance-pool:read on the signer compartment.

variable "rotation_function_image" {
  type = string
  description = "OCIR image URI for the Function (built from ../function/)"
}
variable "signer_max_age_days" {
  type = number
  default = 60
  description = "Max age in days. Instances older than this are terminated."
}
variable "rotation_schedule_cron" {
  type = string
  default = "0 */6 * * *"
  description = "Cron for the OCI Scheduler; every 6 hours."
}

# Function application (namespace for functions)
resource "oci_functions_application" "signer_rotation" {
  compartment_id = var.compartment_ocid
  display_name = "scruple-signer-rotation"
  subnet_ids = [var.signer_subnet_ocid]
  # Function has its own dedicated dynamic-group identity
  # (see iam-policies.tf) rather than instance-principal.
  config = {
    "OCI_COMPARTMENT_ID" = var.compartment_ocid
    "SIGNER_INSTANCE_POOL_OCID" = oci_core_instance_pool.signer.id
    "MAX_AGE_DAYS" = tostring(var.signer_max_age_days)
    "LOG_LEVEL" = "INFO"
  }
  freeform_tags = {
    "component" = "scruple-c2pa-signer"
    "assurance-level" = "L2"
  }
}

# The Function itself
resource "oci_functions_function" "rotate_signer_cvms" {
  application_id = oci_functions_application.signer_rotation.id
  display_name = "rotate-signer-cvms"
  image = var.rotation_function_image
  memory_in_mbs = 256
  timeout_in_seconds = 120
  freeform_tags = {
    "component" = "scruple-c2pa-signer"
    "purpose" = "L2-6.3.2-6.4.2-actuator"
  }
}

# Resource Scheduler: fire the Function per rotation_schedule_cron
resource "oci_resource_scheduler_schedule" "signer_rotation" {
  compartment_id = var.compartment_ocid
  display_name = "scruple-signer-rotation-schedule"

  action = "START_RESOURCE"
  time_zone = "UTC"

  # Note: OCI Resource Scheduler cron uses standard 5-field syntax
  recurrence_details = var.rotation_schedule_cron
  recurrence_type = "CRON"

  resources {
    id = oci_functions_function.rotate_signer_cvms.id
    metadata = {
      "function-name" = oci_functions_function.rotate_signer_cvms.display_name
    }
  }

  freeform_tags = {
    "component" = "scruple-c2pa-signer"
    "purpose" = "L2-6.3.2-6.4.2-scheduler"
  }
}

output "rotation_function_ocid" {
  value = oci_functions_function.rotate_signer_cvms.id
}

output "rotation_schedule_ocid" {
  value = oci_resource_scheduler_schedule.signer_rotation.id
}
