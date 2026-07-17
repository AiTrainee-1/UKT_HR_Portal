from decimal import Decimal


def _float_or_none(value) -> float | None:
    if value is None:
        return None
    return float(value)


def _dt(value):
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        text = value.isoformat()
        if text.endswith("+00:00"):
            return text[:-6] + "Z"
        return text
    return value


def department_json(dept, employee_count: int | None = None) -> dict:
    data = {
        "id": dept.id,
        "name": dept.name,
        "description": dept.description,
    }
    if employee_count is not None:
        data["employeeCount"] = employee_count
    return data


def employee_json(emp, department_name: str | None = None) -> dict:
    designation_title = None
    if hasattr(emp, "designation") and emp.designation_id and emp.designation:
        designation_title = emp.designation.title
    branch_name = None
    branch_code = None
    if hasattr(emp, "branch") and emp.branch_id and emp.branch:
        branch_name = emp.branch.name
        branch_code = emp.branch.code
    return {
        "id": emp.id,
        "employeeCode": emp.employee_code,
        "firstName": emp.first_name,
        "lastName": emp.last_name,
        "gender": emp.gender,
        "dateOfBirth": emp.date_of_birth.isoformat() if emp.date_of_birth else None,
        "email": emp.email,
        "phone": emp.phone,
        "photoUrl": emp.photo_url,
        "bloodGroup": emp.blood_group,
        "emergencyContact": emp.emergency_contact,
        "role": emp.role,
        "employmentType": emp.employment_type,
        "departmentId": emp.department_id,
        "departmentName": department_name,
        "designationId": emp.designation_id,
        "designationTitle": designation_title,
        "branchId": emp.branch_id,
        "branchName": branch_name,
        "branchCode": branch_code,
        "unitCode": emp.unit_code,
        "salaryType": emp.salary_type,
        "salaryAmount": _float_or_none(emp.salary_amount),
        "salaryPerShift": _float_or_none(emp.salary_per_shift),
        "status": emp.status,
        "bankName": emp.bank_name,
        "bankAccount": emp.bank_account,
        "bankIfsc": emp.bank_ifsc,
        "idProof": emp.id_proof,
        "pfNumber": emp.pf_number,
        "esiNumber": emp.esi_number,
        "uanNumber": emp.uan_number,
        "address": emp.address,
        "joinDate": emp.join_date,
        "fatherName": emp.father_name,
        "motherName": emp.mother_name,
        "biometricDeviceId": emp.biometric_device_id,
        "hasPassword": bool(emp.password_hash),
        "createdAt": _dt(emp.created_at),
    }


def salary_record_json(record, employee_name: str | None = None) -> dict:
    return {
        "id": record.id,
        "employeeId": record.employee_id,
        "employeeName": employee_name,
        "month": record.month,
        "year": record.year,
        "amount": _float_or_none(record.amount),
        "type": record.type,
        "weekNumber": record.week_number,
        "status": record.status,
        "notes": record.notes,
        "createdAt": _dt(record.created_at),
    }


def leave_request_json(record, employee_name: str | None = None) -> dict:
    emp = getattr(record, "employee", None)
    # Auto-derive name from the joined employee when caller doesn't supply it
    resolved_name = employee_name or (
        f"{emp.first_name} {emp.last_name}" if emp else None
    )
    return {
        "id": record.id,
        "employeeId": record.employee_id,
        "employeeName": resolved_name,
        "employeeCode": emp.employee_code if emp else None,
        "department": emp.department.name if emp and emp.department_id and emp.department else None,
        "designation": emp.designation.title if emp and emp.designation_id and emp.designation else None,
        "type": record.type,
        "startDate": record.start_date,
        "endDate": record.end_date,
        "totalDays": float(record.total_days) if record.total_days is not None else 1,
        "reason": record.reason,
        "status": record.status,
        "hrComment": record.hr_comment,
        "createdAt": _dt(record.created_at),
    }


def notification_json(record, employee_name: str | None = None) -> dict:
    return {
        "id": record.id,
        "employeeId": record.employee_id,
        "employeeName": employee_name,
        "type": record.type,
        "message": record.message,
        "isRead": record.is_read,
        "createdAt": _dt(record.created_at),
    }


def job_json(job, department_name: str | None = None, applicant_count: int | None = None) -> dict:
    data = {
        "id": job.id,
        "title": job.title,
        "departmentId": job.department_id,
        "departmentName": department_name,
        "description": job.description,
        "requirements": job.requirements,
        "salaryRange": job.salary_range,
        "status": job.status,
        "createdAt": _dt(job.created_at),
    }
    if applicant_count is not None:
        data["applicantCount"] = applicant_count
    return data


def applicant_json(applicant, job_title: str | None = None) -> dict:
    return {
        "id": applicant.id,
        "jobId": applicant.job_id,
        "jobTitle": job_title,
        "name": applicant.name,
        "email": applicant.email,
        "phone": applicant.phone,
        "coverLetter": applicant.cover_letter,
        "experience": applicant.experience,
        "status": applicant.status,
        "interviewDate": applicant.interview_date,
        "notes": applicant.notes,
        "createdAt": _dt(applicant.created_at),
    }


def attendance_json(record) -> dict:
    return {
        "id": record.id,
        "employeeId": record.employee_id,
        "date": record.date,
        "present": record.present,
        "hoursWorked": _float_or_none(record.hours_worked),
        "notes": record.notes,
        "createdAt": _dt(record.created_at),
    }


def employee_full_name(emp: "Employee") -> str:
    return f"{emp.first_name} {emp.last_name}"


def parse_decimal(value) -> Decimal | None:
    if value is None:
        return None
    return Decimal(str(value))
