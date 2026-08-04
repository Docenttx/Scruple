# Signer Instance Pool
#
# Fleet manager for Signer CVMs. Provisions N instances from the
# Instance Configuration and re-provisions on termination. Combined
# with the rotation Function (rotation-function.tf), this enforces
# the 60-day maximum instance age.

variable "signer_pool_target_size" {
  type = number
  default = 2
  description = "Target number of concurrent Signer CVMs. Minimum 2 for rolling replacement without service interruption."
}
variable "signer_availability_domain" {
  type = string
  description = "AD name, e.g. hbAG:US-ASHBURN-AD-1"
}
variable "signer_lb_backend_set_ocid" {
  type = string
  description = "OCID of the Signer LB backend set. Instances are auto-registered/drained on pool events."
}

resource "oci_core_instance_pool" "signer" {
  compartment_id = var.compartment_ocid
  instance_configuration_id = oci_core_instance_configuration.signer_cvm.id
  display_name = "scruple-signer-pool"
  size = var.signer_pool_target_size

  freeform_tags = {
    "component" = "scruple-c2pa-signer"
    "assurance-level" = "L2"
    "rotation-managed" = "true"
    "max-age-days" = "60"
  }

  placement_configurations {
    availability_domain = var.signer_availability_domain
    primary_subnet_id = var.signer_subnet_ocid
  }

  # LB attachment: instances added to backend set on provision, drained on
  # termination. Drain timeout gives in-flight sign operations time to
  # complete before the socket is closed.
  load_balancers {
    load_balancer_id = data.oci_load_balancer_load_balancer.signer.id
    backend_set_name = split(",", var.signer_lb_backend_set_ocid)[0]
    port = 8443
    vnic_selection = "PrimaryVnic"
  }
}

# LB lookup (assumes the LB exists — provisioned separately as part of the
# core Signer infrastructure, not part of this rotation stack)
data "oci_load_balancer_load_balancer" "signer" {
  load_balancer_id = split(",", var.signer_lb_backend_set_ocid)[1]
}

output "instance_pool_ocid" {
  value = oci_core_instance_pool.signer.id
}

output "instance_pool_current_size" {
  value = oci_core_instance_pool.signer.size
}
