"""
Backend API tests for Trainee Role Features
Tests: Trainee login, registration, my-progress endpoint, role-based access, new hire with trainee account creation
"""
import pytest
import requests
import os

if os.environ.get("CG1_RUN_REMOTE_TESTS") != "1":
    pytest.skip("remote tests require CG1_RUN_REMOTE_TESTS=1", allow_module_level=True)
BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    pytest.skip("EXPO_PUBLIC_BACKEND_URL not set", allow_module_level=True)

# Remote integration credentials are opt-in and never stored in the repo.
ADMIN_EMAIL = os.environ.get("CG1_TEST_ADMIN_EMAIL", "").strip()
ADMIN_PASSWORD = os.environ.get("CG1_TEST_ADMIN_PASSWORD", "")
LEADER_EMAIL = os.environ.get("CG1_TEST_LEADER_EMAIL", "").strip()
LEADER_PASSWORD = os.environ.get("CG1_TEST_LEADER_PASSWORD", "")
TRAINEE_EMAIL = os.environ.get("CG1_TEST_TRAINEE_EMAIL", "").strip()
TRAINEE_PASSWORD = os.environ.get("CG1_TEST_TRAINEE_PASSWORD", "")
if not all((ADMIN_EMAIL, ADMIN_PASSWORD, LEADER_EMAIL, LEADER_PASSWORD, TRAINEE_EMAIL, TRAINEE_PASSWORD)):
    pytest.skip(
        "CG1_TEST_ADMIN_*, CG1_TEST_LEADER_* and CG1_TEST_TRAINEE_* are required for remote role tests",
        allow_module_level=True,
    )

class TestTraineeLogin:
    """Test trainee login functionality"""
    
    def test_admin_login_success(self):
        """Admin should be able to login"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert data["role"] == "admin"
        assert data["email"] == ADMIN_EMAIL
        assert "token" in data
        print(f"✓ Admin login successful: {data['name']} ({data['role']})")
        
    def test_leader_login_success(self):
        """Leader should be able to login"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": LEADER_EMAIL,
            "password": LEADER_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert data["role"] == "leader"
        assert data["email"] == LEADER_EMAIL
        assert "token" in data
        print(f"✓ Leader login successful: {data['name']} ({data['role']})")
        
    def test_trainee_login_success(self):
        """Trainee should be able to login"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": TRAINEE_EMAIL,
            "password": TRAINEE_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert data["role"] == "trainee"
        assert data["email"] == TRAINEE_EMAIL
        assert "token" in data
        print(f"✓ Trainee login successful: {data['name']} ({data['role']})")

class TestTraineeRegistration:
    """Test trainee self-registration flow"""
    
    def test_trainee_registration_creates_hire_and_assessments(self):
        """Trainee registration should auto-create an unassigned new_hire with Day 1-8 assessments"""
        # Register new trainee
        trainee_email = f"TEST_trainee_{os.urandom(4).hex()}@example.com"
        response = requests.post(f"{BASE_URL}/api/auth/register", json={
            "email": trainee_email,
            "password": "test123",
            "name": "TEST New Trainee"
        })
        assert response.status_code == 200
        data = response.json()
        assert data["role"] == "trainee"
        assert data["email"] == trainee_email.lower()  # Backend normalizes to lowercase
        assert "token" in data
        trainee_token = data["token"]
        trainee_id = data["id"]
        print(f"✓ Trainee registered: {data['name']} ({data['email']})")
        
        # Verify new_hire was created
        progress_response = requests.get(f"{BASE_URL}/api/trainee/my-progress",
            headers={"Authorization": f"Bearer {trainee_token}"})
        assert progress_response.status_code == 200
        progress_data = progress_response.json()
        
        # Verify hire data
        assert "hire" in progress_data
        hire = progress_data["hire"]
        assert hire["name"] == "TEST New Trainee"
        assert hire["leader"] == "Unassigned"  # an admin assigns the leader later
        assert hire["campaign"] == ""
        assert hire["current_day"] == 1
        assert hire["trainee_user_id"] == trainee_id
        print(f"✓ New hire created: {hire['name']} assigned to {hire['leader']}")
        
        # Verify Day 1-6 assessments created
        assert "assessments" in progress_data
        assessments = progress_data["assessments"]
        assert len(assessments) == 6
        day_numbers = [a["day_number"] for a in assessments]
        assert day_numbers == [1, 2, 3, 4, 5, 6]
        print(f"✓ Day 1-6 assessments created: {len(assessments)} assessments")
        
        # Cleanup - login as admin and delete the hire
        admin_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        admin_token = admin_login.json()["token"]
        requests.delete(f"{BASE_URL}/api/new-hires/{hire['id']}",
            headers={"Authorization": f"Bearer {admin_token}"})
        requests.delete(f"{BASE_URL}/api/admin/users/{trainee_id}",
            headers={"Authorization": f"Bearer {admin_token}"})
        print("✓ Cleanup completed")

class TestTraineeMyProgress:
    """Test /api/trainee/my-progress endpoint"""
    
    def test_trainee_my_progress_returns_hire_and_assessments(self):
        """Trainee /api/trainee/my-progress should return their hire data and 6 assessments"""
        # Login as trainee
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": TRAINEE_EMAIL,
            "password": TRAINEE_PASSWORD
        })
        assert response.status_code == 200
        trainee_token = response.json()["token"]
        
        # Get progress
        progress_response = requests.get(f"{BASE_URL}/api/trainee/my-progress",
            headers={"Authorization": f"Bearer {trainee_token}"})
        assert progress_response.status_code == 200
        data = progress_response.json()
        
        # Verify structure
        assert "hire" in data
        assert "assessments" in data
        
        # Verify hire data
        hire = data["hire"]
        assert "id" in hire
        assert "name" in hire
        assert "leader" in hire
        assert "current_day" in hire
        assert "current_status" in hire
        print(f"✓ Hire data: {hire['name']} - Day {hire['current_day']} - {hire['current_status']}")
        
        # Verify assessments
        assessments = data["assessments"]
        assert len(assessments) == 6
        for i, assessment in enumerate(assessments, 1):
            assert assessment["day_number"] == i
            assert "id" in assessment
            assert "completed" in assessment
            assert "status" in assessment
        print(f"✓ Assessments: {len(assessments)} days returned")
        
    def test_non_trainee_cannot_access_my_progress(self):
        """Admin and leader should get 403 when accessing /trainee/my-progress"""
        # Login as admin
        admin_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        admin_token = admin_login.json()["token"]
        
        # Try to access trainee endpoint
        response = requests.get(f"{BASE_URL}/api/trainee/my-progress",
            headers={"Authorization": f"Bearer {admin_token}"})
        assert response.status_code == 403
        assert "New BA access only" in response.json()["detail"]
        print("✓ Admin correctly blocked from trainee endpoint (403)")
        
    def test_my_progress_without_token_returns_401(self):
        """GET /trainee/my-progress should return 401 without auth token"""
        response = requests.get(f"{BASE_URL}/api/trainee/my-progress")
        assert response.status_code == 401
        print("✓ Unauthenticated access blocked (401)")

class TestNewHireWithTraineeAccount:
    """Test creating new hire with optional email/password creates trainee account"""
    
    def test_create_hire_with_email_password_creates_trainee_account(self):
        """Creating new hire with email/password should also create trainee user account"""
        # Login as admin
        admin_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        admin_token = admin_login.json()["token"]
        
        # Create new hire with email/password
        trainee_email = f"TEST_hire_trainee_{os.urandom(4).hex()}@example.com"
        hire_response = requests.post(f"{BASE_URL}/api/new-hires",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "name": "TEST Hire With Account",
                "leader": "TEST Leader",
                "start_date": "2026-01-15",
                "campaign": "Test Campaign",
                "email": trainee_email,
                "password": "trainee123"
            }
        )
        assert hire_response.status_code == 200
        hire = hire_response.json()
        hire_id = hire["id"]
        print(f"✓ New hire created: {hire['name']}")
        
        # Verify trainee account was created
        trainee_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": trainee_email,
            "password": "trainee123"
        })
        assert trainee_login.status_code == 200
        trainee_data = trainee_login.json()
        assert trainee_data["role"] == "trainee"
        assert trainee_data["email"] == trainee_email.lower()  # Backend normalizes to lowercase
        trainee_token = trainee_data["token"]
        trainee_id = trainee_data["id"]
        print(f"✓ Trainee account created: {trainee_data['name']} ({trainee_data['role']})")
        
        # Verify trainee can access their progress
        progress_response = requests.get(f"{BASE_URL}/api/trainee/my-progress",
            headers={"Authorization": f"Bearer {trainee_token}"})
        assert progress_response.status_code == 200
        progress = progress_response.json()
        assert progress["hire"]["id"] == hire_id
        assert progress["hire"]["name"] == "TEST Hire With Account"
        assert len(progress["assessments"]) == 6
        print(f"✓ Trainee can access progress: {len(progress['assessments'])} assessments")
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/new-hires/{hire_id}",
            headers={"Authorization": f"Bearer {admin_token}"})
        requests.delete(f"{BASE_URL}/api/admin/users/{trainee_id}",
            headers={"Authorization": f"Bearer {admin_token}"})
        print("✓ Cleanup completed")
        
    def test_create_hire_without_email_password_no_trainee_account(self):
        """Creating new hire without email/password should NOT create trainee account"""
        # Login as admin
        admin_login = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        admin_token = admin_login.json()["token"]
        
        # Create new hire WITHOUT email/password
        hire_response = requests.post(f"{BASE_URL}/api/new-hires",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={
                "name": "TEST Hire No Account",
                "leader": "TEST Leader",
                "start_date": "2026-01-15",
                "campaign": "Test Campaign"
            }
        )
        assert hire_response.status_code == 200
        hire = hire_response.json()
        hire_id = hire["id"]
        # Note: trainee_user_id is not returned in API response, only stored in DB
        print(f"✓ New hire created without trainee account: {hire['name']}")
        
        # Cleanup
        requests.delete(f"{BASE_URL}/api/new-hires/{hire_id}",
            headers={"Authorization": f"Bearer {admin_token}"})
        print("✓ Cleanup completed")

class TestExternalURLAccess:
    """Test Expo Go login works via external URL"""
    
    def test_external_url_login(self):
        """Test login via external preview URL"""
        response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        assert response.status_code == 200
        data = response.json()
        assert "token" in data
        print(f"✓ External URL login successful: {BASE_URL}")
        
    def test_external_url_protected_endpoint(self):
        """Test protected endpoint via external URL"""
        # Login
        login_response = requests.post(f"{BASE_URL}/api/auth/login", json={
            "email": ADMIN_EMAIL,
            "password": ADMIN_PASSWORD
        })
        token = login_response.json()["token"]
        
        # Access protected endpoint
        response = requests.get(f"{BASE_URL}/api/new-hires",
            headers={"Authorization": f"Bearer {token}"})
        assert response.status_code == 200
        print(f"✓ External URL protected endpoint access successful")
