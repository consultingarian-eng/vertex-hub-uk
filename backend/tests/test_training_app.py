"""
Backend API tests for the Training & Development App
Tests: New hire creation, assessments, training manual, targets, checklist grading
"""
import pytest
import requests
import os

if os.environ.get("CG1_RUN_REMOTE_TESTS") != "1":
    pytest.skip("remote tests require CG1_RUN_REMOTE_TESTS=1", allow_module_level=True)
BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    pytest.skip("EXPO_PUBLIC_BACKEND_URL must be set for remote tests", allow_module_level=True)

class TestHealthCheck:
    """Basic health check"""
    
    def test_api_root(self):
        response = requests.get(f"{BASE_URL}/api/")
        assert response.status_code == 200
        data = response.json()
        assert "message" in data

class TestTrainingManual:
    """Training manual content tests"""
    
    def test_get_all_training_manual(self):
        response = requests.get(f"{BASE_URL}/api/training-manual")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) > 0
        
    def test_day1_categories(self):
        """Day 1 should have Behaviour, Business, Quality, Pay categories"""
        response = requests.get(f"{BASE_URL}/api/training-manual/1")
        assert response.status_code == 200
        data = response.json()
        categories = set(item['category'] for item in data)
        assert 'Behaviour' in categories
        assert 'Business' in categories
        assert 'Quality' in categories
        assert 'Pay' in categories
        
    def test_day2_categories(self):
        """Day 2 should have Pitch, Qualification, Delivery, Compliance, Product Knowledge, Signup"""
        response = requests.get(f"{BASE_URL}/api/training-manual/2")
        assert response.status_code == 200
        data = response.json()
        categories = set(item['category'] for item in data)
        assert 'Pitch' in categories
        assert 'Qualification' in categories
        assert 'Delivery' in categories
        assert 'Compliance' in categories
        assert 'Product Knowledge' in categories
        assert 'Signup' in categories
        
    def test_confidence_expected_badges(self):
        """Check confidence_expected field exists"""
        response = requests.get(f"{BASE_URL}/api/training-manual/1")
        assert response.status_code == 200
        data = response.json()
        for item in data:
            assert 'confidence_expected' in item
            assert item['confidence_expected'] in ['Understand', 'Assisted', 'Independent']

class TestTargets:
    """Day targets tests"""
    
    def test_get_all_targets(self):
        response = requests.get(f"{BASE_URL}/api/targets")
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 6
        
    def test_day2_targets(self):
        """Day 2: Intro=8"""
        response = requests.get(f"{BASE_URL}/api/targets/2")
        assert response.status_code == 200
        data = response.json()
        assert data['target_intro'] == 8
        assert 'day_objective' in data
        
    def test_day3_targets(self):
        """Day 3: Intro=10, Pres=8, SS=3"""
        response = requests.get(f"{BASE_URL}/api/targets/3")
        assert response.status_code == 200
        data = response.json()
        assert data['target_intro'] == 10
        assert data['target_presentation'] == 8
        assert data['target_short_story'] == 3
        
    def test_day6_targets(self):
        """Day 6: Close=10, Signup=8, Rehash=7"""
        response = requests.get(f"{BASE_URL}/api/targets/6")
        assert response.status_code == 200
        data = response.json()
        assert data['target_close'] == 10
        assert data['target_signup'] == 8
        assert data['target_rehash'] == 7

class TestNewHireCRUD:
    """New hire creation and CRUD tests"""
    
    def test_create_new_hire_and_verify(self):
        """Create new hire and verify it creates Day 1-6 assessments + checklist items"""
        payload = {
            "name": "TEST_John_Doe",
            "leader": "TEST_Leader_Smith",
            "start_date": "2026-01-15",
            "campaign": "Test Campaign"
        }
        
        # Create
        response = requests.post(f"{BASE_URL}/api/new-hires", json=payload)
        assert response.status_code == 200
        hire = response.json()
        assert hire['name'] == payload['name']
        assert hire['leader'] == payload['leader']
        assert hire['current_day'] == 1
        assert hire['current_status'] == 'In Progress'
        hire_id = hire['id']
        
        # Verify persistence with GET
        get_response = requests.get(f"{BASE_URL}/api/new-hires/{hire_id}")
        assert get_response.status_code == 200
        retrieved = get_response.json()
        assert retrieved['name'] == payload['name']
        
        # Verify assessments created for Day 1-6
        assessments_response = requests.get(f"{BASE_URL}/api/assessments/{hire_id}")
        assert assessments_response.status_code == 200
        assessments = assessments_response.json()
        assert len(assessments) == 6
        day_numbers = [a['day_number'] for a in assessments]
        assert day_numbers == [1, 2, 3, 4, 5, 6]
        
        # Verify checklist items created for each assessment
        for assessment in assessments:
            checklist_response = requests.get(f"{BASE_URL}/api/checklist/{assessment['id']}")
            assert checklist_response.status_code == 200
            checklist = checklist_response.json()
            assert len(checklist) > 0
            # Check grade field exists
            for item in checklist:
                assert 'grade' in item
                assert item['grade'] is None  # Initially null
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/new-hires/{hire_id}")
        
    def test_get_new_hires_list(self):
        response = requests.get(f"{BASE_URL}/api/new-hires")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

class TestChecklistGrading:
    """Checklist grading system tests"""
    
    def test_grade_checklist_item_and_verify_score(self):
        """Grade a checklist item and verify checklist_grade_score updates"""
        # Create new hire
        payload = {
            "name": "TEST_Grading_Test",
            "leader": "TEST_Leader",
            "start_date": "2026-01-15"
        }
        hire_response = requests.post(f"{BASE_URL}/api/new-hires", json=payload)
        assert hire_response.status_code == 200
        hire_id = hire_response.json()['id']
        
        # Get Day 1 assessment
        assessments_response = requests.get(f"{BASE_URL}/api/assessments/{hire_id}")
        assessments = assessments_response.json()
        day1_assessment = [a for a in assessments if a['day_number'] == 1][0]
        assessment_id = day1_assessment['id']
        
        # Get checklist items
        checklist_response = requests.get(f"{BASE_URL}/api/checklist/{assessment_id}")
        checklist = checklist_response.json()
        assert len(checklist) > 0
        
        # Grade first 3 items
        item1_id = checklist[0]['id']
        item2_id = checklist[1]['id']
        item3_id = checklist[2]['id']
        
        # Grade with Excellent (10), Average (7), Below Average (4)
        requests.put(f"{BASE_URL}/api/checklist/{item1_id}", json={"grade": "Excellent"})
        requests.put(f"{BASE_URL}/api/checklist/{item2_id}", json={"grade": "Average"})
        requests.put(f"{BASE_URL}/api/checklist/{item3_id}", json={"grade": "Below Average"})
        
        # Verify grades persisted
        checklist_after = requests.get(f"{BASE_URL}/api/checklist/{assessment_id}").json()
        graded_items = [i for i in checklist_after if i['grade'] is not None]
        assert len(graded_items) == 3
        
        # Verify checklist_grade_score calculated on assessment
        assessment_after = requests.get(f"{BASE_URL}/api/assessment/{assessment_id}").json()
        assert assessment_after['checklist_grade_score'] is not None
        # Expected: (10 + 7 + 4) / 3 = 7.0
        assert abs(assessment_after['checklist_grade_score'] - 7.0) < 0.1
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/new-hires/{hire_id}")

class TestAssessmentScoring:
    """Assessment scoring formula tests"""
    
    def test_day1_scoring_100_percent_behaviour(self):
        """Day 1: 100% behaviours"""
        # Create new hire
        payload = {"name": "TEST_Day1_Scoring", "leader": "TEST_Leader", "start_date": "2026-01-15"}
        hire_response = requests.post(f"{BASE_URL}/api/new-hires", json=payload)
        hire_id = hire_response.json()['id']
        
        # Get Day 1 assessment
        assessments = requests.get(f"{BASE_URL}/api/assessments/{hire_id}").json()
        day1 = [a for a in assessments if a['day_number'] == 1][0]
        
        # Update with behaviour scores
        update_payload = {
            "behaviour_punctuality": 10,
            "behaviour_engagement": 9,
            "behaviour_image": 8,
            "behaviour_coachability": 10,
            "behaviour_attitude": 9,
            "completed": True
        }
        requests.put(f"{BASE_URL}/api/assessment/{day1['id']}", json=update_payload)
        
        # Verify scoring
        updated = requests.get(f"{BASE_URL}/api/assessment/{day1['id']}").json()
        # Expected behaviour_score: (10+9+8+10+9)/5 = 9.2
        assert updated['behaviour_score'] is not None
        assert abs(updated['behaviour_score'] - 9.2) < 0.1
        # Day 1: overall_score = behaviour_score
        assert abs(updated['overall_score'] - 9.2) < 0.1
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/new-hires/{hire_id}")
        
    def test_day2_scoring_50_50_split(self):
        """Day 2: 50% behaviours, 50% skills"""
        payload = {"name": "TEST_Day2_Scoring", "leader": "TEST_Leader", "start_date": "2026-01-15"}
        hire_response = requests.post(f"{BASE_URL}/api/new-hires", json=payload)
        hire_id = hire_response.json()['id']
        
        assessments = requests.get(f"{BASE_URL}/api/assessments/{hire_id}").json()
        day2 = [a for a in assessments if a['day_number'] == 2][0]
        
        # Day 2 target_intro = 8
        update_payload = {
            "behaviour_punctuality": 10,
            "behaviour_engagement": 10,
            "behaviour_image": 10,
            "behaviour_coachability": 10,
            "behaviour_attitude": 10,
            "skill_intro": 8,  # Meets target
            "completed": True
        }
        requests.put(f"{BASE_URL}/api/assessment/{day2['id']}", json=update_payload)
        
        updated = requests.get(f"{BASE_URL}/api/assessment/{day2['id']}").json()
        # behaviour_score = 10, skill_score = 10 (8/8 * 10)
        # overall = (10 * 0.5) + (10 * 0.5) = 10
        assert updated['overall_score'] is not None
        assert abs(updated['overall_score'] - 10.0) < 0.1
        
        requests.delete(f"{BASE_URL}/api/new-hires/{hire_id}")

class TestStatusCalculation:
    """Status calculation tests"""
    
    def test_status_thresholds(self):
        """Test status: >=10 S-GREEN, >=9 Green, >=7 Yellow, <7 Red"""
        payload = {"name": "TEST_Status", "leader": "TEST_Leader", "start_date": "2026-01-15"}
        hire_response = requests.post(f"{BASE_URL}/api/new-hires", json=payload)
        hire_id = hire_response.json()['id']
        
        assessments = requests.get(f"{BASE_URL}/api/assessments/{hire_id}").json()
        day1 = [a for a in assessments if a['day_number'] == 1][0]
        
        # Test S-GREEN (>=10)
        requests.put(f"{BASE_URL}/api/assessment/{day1['id']}", json={
            "behaviour_punctuality": 10, "behaviour_engagement": 10,
            "behaviour_image": 10, "behaviour_coachability": 10, "behaviour_attitude": 10
        })
        result = requests.get(f"{BASE_URL}/api/assessment/{day1['id']}").json()
        assert result['status'] == 'S-GREEN'
        
        # Test Green (>=9)
        requests.put(f"{BASE_URL}/api/assessment/{day1['id']}", json={
            "behaviour_punctuality": 9, "behaviour_engagement": 9,
            "behaviour_image": 9, "behaviour_coachability": 9, "behaviour_attitude": 9
        })
        result = requests.get(f"{BASE_URL}/api/assessment/{day1['id']}").json()
        assert result['status'] == 'Green'
        
        # Test Yellow (>=7)
        requests.put(f"{BASE_URL}/api/assessment/{day1['id']}", json={
            "behaviour_punctuality": 7, "behaviour_engagement": 7,
            "behaviour_image": 7, "behaviour_coachability": 7, "behaviour_attitude": 7
        })
        result = requests.get(f"{BASE_URL}/api/assessment/{day1['id']}").json()
        assert result['status'] == 'Yellow'
        
        # Test Red (<7)
        requests.put(f"{BASE_URL}/api/assessment/{day1['id']}", json={
            "behaviour_punctuality": 5, "behaviour_engagement": 5,
            "behaviour_image": 5, "behaviour_coachability": 5, "behaviour_attitude": 5
        })
        result = requests.get(f"{BASE_URL}/api/assessment/{day1['id']}").json()
        assert result['status'] == 'Red'
        
        requests.delete(f"{BASE_URL}/api/new-hires/{hire_id}")

class TestDashboard:
    """Dashboard stats tests"""
    
    def test_dashboard_stats(self):
        response = requests.get(f"{BASE_URL}/api/dashboard/stats")
        assert response.status_code == 200
        data = response.json()
        assert 'total_active_hires' in data
        assert 'status_breakdown' in data
        assert 'outcome_breakdown' in data
        assert 'average_score_by_day' in data
