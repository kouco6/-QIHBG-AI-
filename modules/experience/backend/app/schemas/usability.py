"""可用性研究请求模型（T09 / N12）。

硬性口径（PRD §10.1）：

- 满意度仅接受 **1–10** 的整数；越界一律 422，文案使用肯定式要求；
- SUS 十题仅接受 **1–5** 的整数；**缺题不计算**（服务层返回 ``sus_score=None``）；
- 任务耗时 ``duration_seconds`` 不得为负；
- 参与者别名在研究会内唯一，重复 409（在服务层校验）。

这里**不**用 pydantic 的 ``ge`` / ``le`` 约束数值范围，原因是校验失败文案要
可控（肯定式中文提示），由服务层统一抛出 422。
"""

from __future__ import annotations

from pydantic import BaseModel, Field

# --- 研究 ---


class StudyCreateRequest(BaseModel):
    project_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=200)
    study_kind: str = Field(min_length=1)
    version_code: str = Field(default="", max_length=64)
    script_artifact_id: str | None = None
    note: str = Field(default="", max_length=4000)


class StudyUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    version_code: str | None = Field(default=None, max_length=64)
    script_artifact_id: str | None = None
    note: str | None = Field(default=None, max_length=4000)
    expected_version: int | None = None


class StudyNaRequest(BaseModel):
    reason: str | None = None


# --- 参与者 ---


class ParticipantIn(BaseModel):
    alias: str = Field(min_length=1, max_length=32)
    group_type: str = Field(default="novice", max_length=16)


class ParticipantBatchRequest(BaseModel):
    participants: list[ParticipantIn] = Field(default_factory=list)


class ParticipantUpdateRequest(BaseModel):
    is_valid: bool | None = None
    exclusion_reason: str | None = None
    satisfaction: int | None = None
    note: str | None = None


# --- 任务 ---


class TaskCreateRequest(BaseModel):
    flow: str = Field(default="", max_length=32)
    module: str = Field(default="", max_length=120)
    content: str = Field(min_length=1)
    expected: str = Field(default="")
    task_no: int | None = None


class TaskUpdateRequest(BaseModel):
    flow: str | None = Field(default=None, max_length=32)
    module: str | None = Field(default=None, max_length=120)
    content: str | None = None
    expected: str | None = None
    task_no: int | None = None


class TaskImportRequest(BaseModel):
    artifact_id: str = Field(min_length=1)


# --- 运行记录 ---


class RunUpsertRequest(BaseModel):
    task_id: str = Field(min_length=1)
    participant_id: str = Field(min_length=1)
    status: str = Field(min_length=1)
    duration_seconds: int | None = None
    error_steps: str = Field(default="")
    error_count: int | None = None
    note: str = Field(default="")


# --- SUS ---


class SusUpsertRequest(BaseModel):
    participant_id: str = Field(min_length=1)
    q1: int | None = None
    q2: int | None = None
    q3: int | None = None
    q4: int | None = None
    q5: int | None = None
    q6: int | None = None
    q7: int | None = None
    q8: int | None = None
    q9: int | None = None
    q10: int | None = None
    satisfaction: int | None = None


class SusCalculateRequest(BaseModel):
    q1: int | None = None
    q2: int | None = None
    q3: int | None = None
    q4: int | None = None
    q5: int | None = None
    q6: int | None = None
    q7: int | None = None
    q8: int | None = None
    q9: int | None = None
    q10: int | None = None


# --- 报告 ---


class ReportRequest(BaseModel):
    create_artifact: bool = False
    top_n: int = 5
