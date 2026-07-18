"""Scruple Signer CVM rotation Function.

Fires on OCI Resource Scheduler cron (every 6 hours). Enumerates Signer
Instance Pool members, computes age from OCI Compute API, terminates any
instance with age > MAX_AGE_DAYS. Instance Pool auto-replaces from the
current Instance Configuration.

Env (set by rotation-function.tf):
  OCI_COMPARTMENT_ID           — where to look for pool + instances
  SIGNER_INSTANCE_POOL_OCID    — the pool to enforce max-age on
  MAX_AGE_DAYS                 — threshold, e.g. "60"
  LOG_LEVEL                    — "INFO" (default) or "DEBUG"

Runtime: OCI Instance Principal (dynamic-group scoped, see iam-policies.tf).
No long-lived credentials.

Purpose: C2PA Generator Product Security Requirements 6.3.2 / 6.4.2
actuator. Reviewer 2026-07-16 required an explicit, dynamic mechanism
enforcing the 90-day OS patch window on running CVMs. This Function
enforces a stricter 60-day window architecturally: no in-service Signer
CVM can age past the window because this Function terminates any that do.
"""

from __future__ import annotations

import io
import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List

import oci
from fdk import response


logger = logging.getLogger("scruple.signer.rotation")
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))


def _age_days(created_iso: str) -> float:
    """Convert an OCI-returned RFC3339 timestamp to days since now (UTC)."""
    # OCI returns e.g. "2026-07-15T04:00:00.123456+00:00"
    # datetime.fromisoformat handles this in 3.11+; use dateutil-free path:
    if created_iso.endswith("Z"):
        created_iso = created_iso[:-1] + "+00:00"
    dt = datetime.fromisoformat(created_iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - dt
    return delta.total_seconds() / 86400.0


def _enumerate_pool_instances(
    compute_client: oci.core.ComputeClient,
    compute_mgmt_client: oci.core.ComputeManagementClient,
    compartment_id: str,
    pool_ocid: str,
) -> List[Dict[str, Any]]:
    """Return list of {instance_id, display_name, time_created, lifecycle_state}
    for every instance in the pool."""
    out: List[Dict[str, Any]] = []
    page = None
    while True:
        resp = compute_mgmt_client.list_instance_pool_instances(
            compartment_id=compartment_id,
            instance_pool_id=pool_ocid,
            page=page,
        )
        for m in resp.data:
            # m is InstancePoolInstance — attrs include id, display_name,
            # state, time_created (RFC3339 string), availability_domain
            out.append({
                "instance_id": m.id,
                "display_name": m.display_name,
                "state": m.state,
                "time_created": (
                    m.time_created.isoformat() if hasattr(m.time_created, "isoformat")
                    else str(m.time_created)
                ),
            })
        page = resp.headers.get("opc-next-page")
        if not page:
            break
    return out


def _terminate_instance(
    compute_client: oci.core.ComputeClient,
    instance_id: str,
) -> Dict[str, Any]:
    """Terminate a single instance. Instance Pool will auto-replace."""
    # preserve_boot_volume=False so the replacement provisions cleanly from
    # the Instance Configuration's source image, not a stale volume.
    compute_client.terminate_instance(
        instance_id=instance_id,
        preserve_boot_volume=False,
    )
    return {"instance_id": instance_id, "terminate_call": "ok"}


def _rotate_once(
    compute_client: oci.core.ComputeClient,
    compute_mgmt_client: oci.core.ComputeManagementClient,
    compartment_id: str,
    pool_ocid: str,
    max_age_days: float,
) -> Dict[str, Any]:
    """One pass: enumerate pool, terminate any instance > max_age_days.

    Returns a summary suitable for logging + Function response body."""
    instances = _enumerate_pool_instances(
        compute_client, compute_mgmt_client, compartment_id, pool_ocid,
    )
    logger.info(f"pool={pool_ocid} member_count={len(instances)}")

    terminated: List[Dict[str, Any]] = []
    kept: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    for inst in instances:
        if inst["state"] != "Running":
            # Skip transitional states; the pool is handling them.
            logger.debug(
                f"skip {inst['instance_id'][:40]} state={inst['state']}"
            )
            continue
        try:
            age = _age_days(inst["time_created"])
        except Exception as e:
            logger.warning(
                f"failed to parse time_created for {inst['instance_id']}: {e}"
            )
            errors.append({**inst, "error": f"parse_time_created: {e}"})
            continue
        record = {**inst, "age_days": round(age, 3)}
        if age > max_age_days:
            logger.info(
                f"TERMINATE {inst['display_name']} age={age:.2f}d "
                f"exceeds max={max_age_days}d"
            )
            try:
                res = _terminate_instance(compute_client, inst["instance_id"])
                terminated.append({**record, "action": res})
            except Exception as e:
                logger.error(
                    f"terminate FAILED for {inst['instance_id']}: {e}"
                )
                errors.append({**record, "error": f"terminate: {e}"})
        else:
            logger.debug(
                f"keep {inst['display_name']} age={age:.2f}d "
                f"(under max={max_age_days}d)"
            )
            kept.append(record)

    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "pool_ocid": pool_ocid,
        "max_age_days": max_age_days,
        "counts": {
            "total": len(instances),
            "terminated": len(terminated),
            "kept": len(kept),
            "errors": len(errors),
        },
        "terminated": terminated,
        "kept": kept,
        "errors": errors,
    }


def handler(ctx, data: io.BytesIO = None):
    """OCI Functions entrypoint."""
    compartment_id = os.environ["OCI_COMPARTMENT_ID"]
    pool_ocid = os.environ["SIGNER_INSTANCE_POOL_OCID"]
    max_age_days = float(os.environ.get("MAX_AGE_DAYS", "60"))

    # Instance Principal auth — OCI Functions run with the caller identity
    # of the dynamic-group defined in iam-policies.tf.
    signer = oci.auth.signers.get_resource_principals_signer()
    compute_client = oci.core.ComputeClient(config={}, signer=signer)
    compute_mgmt_client = oci.core.ComputeManagementClient(
        config={}, signer=signer,
    )

    try:
        result = _rotate_once(
            compute_client, compute_mgmt_client,
            compartment_id, pool_ocid, max_age_days,
        )
        return response.Response(
            ctx, response_data=json.dumps(result),
            headers={"Content-Type": "application/json"},
        )
    except Exception as e:
        logger.exception("rotation failed")
        return response.Response(
            ctx, response_data=json.dumps({
                "error": str(e),
                "type": type(e).__name__,
            }),
            headers={"Content-Type": "application/json"},
            status_code=500,
        )
