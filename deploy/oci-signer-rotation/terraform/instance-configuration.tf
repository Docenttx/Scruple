# Signer CVM Instance Configuration
#
# Immutable descriptor for a Signer CVM. Any change to the shape, image,
# cloud-init, or network config bumps the Instance Configuration version;
# the Instance Pool picks up the new version on next replacement.
#
# Companion to:
#   instance-pool.tf         — fleet manager pointing at this configuration
#   rotation-function.tf     — actuator that terminates aged instances
#   iam-policies.tf          — least-privilege identity for the Function
#
# Not intended to run standalone. Assumes tenancy variables + provider
# are declared in the caller's root module.

variable "tenancy_ocid" { type = string }
variable "compartment_ocid" { type = string }
variable "signer_subnet_ocid" { type = string }
variable "signer_nsg_ocid" { type = string }
variable "signer_image_ocid" {
  type = string
  description = "OCID of the current CI-verified golden Signer image (Oracle Linux 9)"
}
variable "signer_cloud_init_path" {
  type = string
  default = "../../../docs/c2pa-conformance-evidence/2026-07-14/security-architecture/runbooks/cloud-init-signer-cvm-oraclelinux.yaml"
  description = "Path to the cloud-init YAML that bootstraps the Signer on first boot"
}
variable "signer_config_version" {
  type = string
  default = "2026-07-18"
  description = "Human-readable version tag for this Instance Configuration"
}

# Read the reviewed cloud-init YAML verbatim
data "local_file" "cloud_init" {
  filename = var.signer_cloud_init_path
}

resource "oci_core_instance_configuration" "signer_cvm" {
  compartment_id = var.compartment_ocid
  display_name = "scruple-signer-cvm-${var.signer_config_version}"

  freeform_tags = {
    "component" = "scruple-c2pa-signer"
    "assurance-level" = "L2"
    "config-version" = var.signer_config_version
    "rotation-managed" = "true"
  }

  instance_details {
    instance_type = "compute"

    launch_details {
      compartment_id = var.compartment_ocid
      shape = "VM.Standard.E5.Flex"
      shape_config {
        ocpus = 2
        memory_in_gbs = 16
      }

      # SEV-SNP Confidential VM — required per §C.2.2 of the source GPSA.
      # Every launched instance publishes an attestation report cryptographically
      # binding its HSM key SPKI to the SEV-SNP measurement.
      platform_config {
        type = "AMD_ROME_BM"
        is_symmetric_multi_threading_enabled = false
        is_memory_encryption_enabled = true
      }
      launch_options {
        # SR-IOV networking; standard for CVM performance.
        network_type = "VFIO"
      }

      source_details {
        source_type = "image"
        image_id = var.signer_image_ocid
      }

      create_vnic_details {
        subnet_id = var.signer_subnet_ocid
        nsg_ids = [var.signer_nsg_ocid]
        assign_public_ip = false
      }

      # cloud-init runs at first boot: attaches SoftHSM, enrolls the OCI Vault
      # AES key, mounts /var/lib/scruple-signer, starts scruple-c2pa-signer.service.
      # This YAML is the reviewed evidence artifact for §C.2.1 / §C.2.2 / §C.2.6.
      metadata = {
        user_data = base64encode(data.local_file.cloud_init.content)
        # IMDSv2 required; the Signer reads its own instance_created_time from
        # IMDS to compute age. See services/c2pa-signer/vault_sign.py.
      }

      instance_options {
        are_legacy_imds_endpoints_disabled = true
      }

      availability_config {
        recovery_action = "RESTORE_INSTANCE"
      }

      # OCI Instance Principal — no long-lived credentials on the CVM.
      # Vault access + Object Storage evidence writes go through this.
      # (Instance Configuration itself doesn't set this; the launched
      # instance inherits from the compartment's Dynamic Group.)
    }
  }
}

output "instance_configuration_ocid" {
  value = oci_core_instance_configuration.signer_cvm.id
}
